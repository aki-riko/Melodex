//go:build ignore

package main

import (
	"bytes"
	"crypto/sha256"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	lineWindowWidth   = 5
	tokenWindowWidth  = 60
	maxPrintedMatches = 10
)

type sourcePoint struct {
	path string
	line int
}

type tokenPoint struct {
	value  string
	line   int
	offset int
}

type sourceSpan struct {
	start int
	end   int
}

type parsedGoFile struct {
	path      string
	isTest    bool
	tokens    []tokenPoint
	codeLines []tokenPoint
	functions map[string]sourcePoint
}

type match struct {
	current   sourcePoint
	reference sourcePoint
}

type auditSummary struct {
	productionLineWindows  int
	testLineWindows        int
	productionTokenWindows int
	testTokenWindows       int
	productionFunctions    int
	testFunctions          int
	exactFiles             int
	charlesCompared        int
	charlesMismatches      int
}

func main() {
	currentRoot := flag.String("current", ".", "Melodex backend root")
	oldGoRoot := flag.String("old-go", "", "fixed go-music-dl checkout")
	oldLibRoot := flag.String("old-lib", "", "fixed music-lib checkout")
	charlesRoot := flag.String("charles", "", "fixed CharlesPikachu/musicdl checkout")
	flag.Parse()

	required := map[string]string{
		"-old-go":  *oldGoRoot,
		"-old-lib": *oldLibRoot,
		"-charles": *charlesRoot,
	}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			fatalf("%s is required", name)
		}
	}

	current, err := loadGoTree(*currentRoot, true)
	check(err)
	oldGo, err := loadGoTree(*oldGoRoot, false)
	check(err)
	oldLib, err := loadGoTree(*oldLibRoot, false)
	check(err)
	references := append(oldGo, oldLib...)

	summary, matches := compareGoTrees(current, references)
	exactMatches, err := compareWholeFiles(*currentRoot, []string{*oldGoRoot, *oldLibRoot})
	check(err)
	summary.exactFiles = len(exactMatches)

	localCharles := filepath.Join(*currentRoot, "third_party", "charles-musicdl")
	summary.charlesCompared, summary.charlesMismatches, err = compareCharlesSnapshot(localCharles, *charlesRoot)
	check(err)

	printSummary(summary, len(current), len(references))
	printMatches(matches)
	for _, item := range exactMatches {
		fmt.Printf("exact-file current=%s reference=%s\n", item.current.path, item.reference.path)
	}

	if summary.productionTokenWindows > 0 || summary.testTokenWindows > 0 ||
		summary.productionFunctions > 0 || summary.testFunctions > 0 ||
		summary.exactFiles > 0 || summary.charlesMismatches > 0 {
		os.Exit(1)
	}
}

func loadGoTree(root string, excludeThirdParty bool) ([]parsedGoFile, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	files := make([]parsedGoFile, 0)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" ||
				(excludeThirdParty && entry.Name() == "third_party") {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || filepath.Base(path) == "provenance_audit.go" {
			return nil
		}
		parsed, parseErr := parseGoFile(path)
		if parseErr != nil {
			return parseErr
		}
		files = append(files, parsed)
		return nil
	})
	return files, err
}

func parseGoFile(path string) (parsedGoFile, error) {
	source, err := os.ReadFile(path)
	if err != nil {
		return parsedGoFile{}, err
	}
	set := token.NewFileSet()
	tree, err := parser.ParseFile(set, path, source, 0)
	if err != nil {
		return parsedGoFile{}, fmt.Errorf("parse %s: %w", path, err)
	}
	file := set.File(tree.Pos())
	skipped := []sourceSpan{{start: file.Offset(tree.Package), end: file.Offset(tree.Name.End())}}
	for _, declaration := range tree.Decls {
		general, ok := declaration.(*ast.GenDecl)
		if ok && general.Tok == token.IMPORT {
			skipped = append(skipped, sourceSpan{start: file.Offset(general.Pos()), end: file.Offset(general.End())})
		}
	}

	points := scanTokens(file, source, skipped)
	functions := make(map[string]sourcePoint)
	for _, declaration := range tree.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		start := file.Offset(function.Pos())
		end := file.Offset(function.End())
		values := make([]string, 0)
		for _, point := range points {
			if point.offset >= start && point.offset < end {
				values = append(values, point.value)
			}
		}
		if len(values) >= 20 {
			functions[strings.Join(values, "\x1f")] = sourcePoint{path: path, line: file.Line(function.Pos())}
		}
	}

	codeLines := groupTokenLines(points)
	return parsedGoFile{
		path: path, isTest: strings.HasSuffix(path, "_test.go"), tokens: points,
		codeLines: codeLines, functions: functions,
	}, nil
}

func scanTokens(file *token.File, source []byte, skipped []sourceSpan) []tokenPoint {
	var lexical scanner.Scanner
	lexical.Init(file, source, nil, 0)
	points := make([]tokenPoint, 0)
	for {
		position, item, literal := lexical.Scan()
		if item == token.EOF {
			break
		}
		offset := file.Offset(position)
		if insideAny(offset, skipped) || item == token.SEMICOLON {
			continue
		}
		value := item.String()
		if literal != "" {
			value = literal
		}
		points = append(points, tokenPoint{value: value, line: file.Line(position), offset: offset})
	}
	return points
}

func insideAny(offset int, spans []sourceSpan) bool {
	for _, span := range spans {
		if offset >= span.start && offset < span.end {
			return true
		}
	}
	return false
}

func groupTokenLines(tokens []tokenPoint) []tokenPoint {
	byLine := make(map[int][]string)
	lines := make([]int, 0)
	for _, point := range tokens {
		if _, exists := byLine[point.line]; !exists {
			lines = append(lines, point.line)
		}
		byLine[point.line] = append(byLine[point.line], point.value)
	}
	sort.Ints(lines)
	result := make([]tokenPoint, 0, len(lines))
	for _, line := range lines {
		result = append(result, tokenPoint{value: strings.Join(byLine[line], " "), line: line})
	}
	return result
}

func compareGoTrees(current, references []parsedGoFile) (auditSummary, map[string][]match) {
	lineReference := indexWindows(references, lineWindowWidth, true)
	tokenReference := indexWindows(references, tokenWindowWidth, false)
	functionReference := make(map[string]sourcePoint)
	for _, file := range references {
		for key, point := range file.functions {
			if _, exists := functionReference[key]; !exists {
				functionReference[key] = point
			}
		}
	}

	summary := auditSummary{}
	matches := map[string][]match{"line": {}, "token": {}, "function": {}}
	for _, file := range current {
		lineMatches := matchWindows(file, lineReference, lineWindowWidth, true)
		tokenMatches := matchWindows(file, tokenReference, tokenWindowWidth, false)
		functionMatches := make([]match, 0)
		for key, currentPoint := range file.functions {
			if referencePoint, exists := functionReference[key]; exists {
				functionMatches = append(functionMatches, match{current: currentPoint, reference: referencePoint})
			}
		}
		if file.isTest {
			summary.testLineWindows += len(lineMatches)
			summary.testTokenWindows += len(tokenMatches)
			summary.testFunctions += len(functionMatches)
		} else {
			summary.productionLineWindows += len(lineMatches)
			summary.productionTokenWindows += len(tokenMatches)
			summary.productionFunctions += len(functionMatches)
		}
		matches["line"] = append(matches["line"], lineMatches...)
		matches["token"] = append(matches["token"], tokenMatches...)
		matches["function"] = append(matches["function"], functionMatches...)
	}
	return summary, matches
}

func indexWindows(files []parsedGoFile, width int, useLines bool) map[string]sourcePoint {
	index := make(map[string]sourcePoint)
	for _, file := range files {
		items := file.tokens
		if useLines {
			items = file.codeLines
		}
		for start := 0; start+width <= len(items); start++ {
			key := windowKey(items, start, width)
			if _, exists := index[key]; !exists {
				index[key] = sourcePoint{path: file.path, line: items[start].line}
			}
		}
	}
	return index
}

func matchWindows(file parsedGoFile, reference map[string]sourcePoint, width int, useLines bool) []match {
	items := file.tokens
	if useLines {
		items = file.codeLines
	}
	result := make([]match, 0)
	for start := 0; start+width <= len(items); start++ {
		if point, exists := reference[windowKey(items, start, width)]; exists {
			result = append(result, match{
				current: sourcePoint{path: file.path, line: items[start].line}, reference: point,
			})
		}
	}
	return result
}

func windowKey(items []tokenPoint, start, width int) string {
	values := make([]string, width)
	for offset := range width {
		values[offset] = items[start+offset].value
	}
	return strings.Join(values, "\x1f")
}

func compareWholeFiles(currentRoot string, referenceRoots []string) ([]match, error) {
	referenceHashes := make(map[[32]byte]sourcePoint)
	for _, root := range referenceRoots {
		err := walkRegularFiles(root, func(path string, data []byte) {
			if !isLicenseFile(path) {
				referenceHashes[sha256.Sum256(data)] = sourcePoint{path: path}
			}
		})
		if err != nil {
			return nil, err
		}
	}
	result := make([]match, 0)
	err := walkRegularFiles(currentRoot, func(path string, data []byte) {
		if strings.Contains(filepath.ToSlash(path), "/third_party/") || isLicenseFile(path) {
			return
		}
		if reference, exists := referenceHashes[sha256.Sum256(data)]; exists {
			result = append(result, match{current: sourcePoint{path: path}, reference: reference})
		}
	})
	return result, err
}

func compareCharlesSnapshot(localRoot, upstreamRoot string) (int, int, error) {
	localRoot, err := filepath.Abs(localRoot)
	if err != nil {
		return 0, 0, err
	}
	upstreamRoot, err = filepath.Abs(upstreamRoot)
	if err != nil {
		return 0, 0, err
	}
	compared := 0
	mismatches := 0
	err = walkRegularFiles(localRoot, func(path string, data []byte) {
		if filepath.Base(path) == "UPSTREAM.md" {
			return
		}
		relative, relErr := filepath.Rel(localRoot, path)
		if relErr != nil {
			mismatches++
			return
		}
		upstreamData, readErr := os.ReadFile(filepath.Join(upstreamRoot, relative))
		compared++
		if readErr != nil || !bytes.Equal(data, upstreamData) {
			mismatches++
			fmt.Printf("charles-mismatch path=%s\n", relative)
		}
	})
	return compared, mismatches, err
}

func walkRegularFiles(root string, visit func(path string, data []byte)) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "__pycache__" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) == ".pyc" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		visit(path, data)
		return nil
	})
}

func isLicenseFile(path string) bool {
	name := strings.ToUpper(filepath.Base(path))
	return name == "LICENSE" || name == "COPYING"
}

func printSummary(summary auditSummary, currentFiles, referenceFiles int) {
	fmt.Printf("current_go_files=%d reference_go_files=%d\n", currentFiles, referenceFiles)
	fmt.Printf("production_five_line_windows=%d test_five_line_windows=%d\n", summary.productionLineWindows, summary.testLineWindows)
	fmt.Printf("production_sixty_token_windows=%d test_sixty_token_windows=%d\n", summary.productionTokenWindows, summary.testTokenWindows)
	fmt.Printf("production_exact_functions=%d test_exact_functions=%d exact_nonlicense_files=%d\n", summary.productionFunctions, summary.testFunctions, summary.exactFiles)
	fmt.Printf("charles_files_compared=%d charles_mismatches=%d\n", summary.charlesCompared, summary.charlesMismatches)
}

func printMatches(groups map[string][]match) {
	for _, kind := range []string{"function", "token", "line"} {
		items := groups[kind]
		counts := make(map[string]int)
		for _, item := range items {
			counts[item.current.path]++
		}
		paths := make([]string, 0, len(counts))
		for path := range counts {
			paths = append(paths, path)
		}
		sort.Slice(paths, func(left, right int) bool {
			if counts[paths[left]] == counts[paths[right]] {
				return paths[left] < paths[right]
			}
			return counts[paths[left]] > counts[paths[right]]
		})
		for _, path := range paths {
			fmt.Printf("%s-file count=%d current=%s\n", kind, counts[path], path)
		}
		limit := min(len(items), maxPrintedMatches)
		for _, item := range items[:limit] {
			fmt.Printf("%s-match current=%s:%d reference=%s:%d\n", kind, item.current.path, item.current.line, item.reference.path, item.reference.line)
		}
		if len(items) > limit {
			fmt.Printf("%s-match omitted=%d\n", kind, len(items)-limit)
		}
	}
}

func check(err error) {
	if err != nil {
		fatalf("%v", err)
	}
}

func fatalf(format string, values ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", values...)
	os.Exit(2)
}
