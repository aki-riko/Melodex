package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

const (
	DatabaseDSNEnv          = "MUSIC_DL_DATABASE_DSN"
	DatabaseDriverEnv       = "MUSIC_DL_DATABASE_DRIVER"
	LegacySQLiteDatabaseEnv = "MUSIC_DL_LEGACY_SQLITE_DB"
)

func databaseDriver() string {
	driver := strings.ToLower(strings.TrimSpace(os.Getenv(DatabaseDriverEnv)))
	if driver != "" {
		return driver
	}
	if strings.TrimSpace(os.Getenv(DatabaseDSNEnv)) != "" {
		return "postgres"
	}
	return "sqlite"
}

// UsingPostgres reports whether the app's primary GORM database is PostgreSQL.
func UsingPostgres() bool {
	driver := databaseDriver()
	return driver == "postgres" || driver == "postgresql"
}

// LegacySQLiteDBPath returns the old unified SQLite database used for one-time
// migrations into PostgreSQL.
func LegacySQLiteDBPath() string {
	if path := strings.TrimSpace(os.Getenv(LegacySQLiteDatabaseEnv)); path != "" {
		return filepath.Clean(path)
	}
	return filepath.Clean(configDBPath())
}

// OpenAppDatabase opens the canonical Melodex database. By default it preserves
// the existing SQLite behavior. When MUSIC_DL_DATABASE_DSN is set, PostgreSQL is
// used unless MUSIC_DL_DATABASE_DRIVER explicitly says otherwise.
func OpenAppDatabase() (*gorm.DB, error) {
	switch databaseDriver() {
	case "postgres", "postgresql":
		dsn := strings.TrimSpace(os.Getenv(DatabaseDSNEnv))
		if dsn == "" {
			return nil, fmt.Errorf("%s is required when %s=postgres", DatabaseDSNEnv, DatabaseDriverEnv)
		}
		return gorm.Open(postgres.Open(dsn), &gorm.Config{})
	case "sqlite", "sqlite3":
		dbPath := strings.TrimSpace(os.Getenv(DatabaseDSNEnv))
		if dbPath == "" {
			dbPath = ConfigDBPath()
		}
		dbPath = filepath.Clean(dbPath)
		if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
			return nil, err
		}
		return gorm.Open(sqlite.Open(dbPath+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"), &gorm.Config{})
	default:
		return nil, fmt.Errorf("unsupported database driver %q", databaseDriver())
	}
}

// IsPostgresDB checks the actual GORM dialect on an opened database.
func IsPostgresDB(db *gorm.DB) bool {
	return db != nil && strings.EqualFold(db.Dialector.Name(), "postgres")
}
