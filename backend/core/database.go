package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

const (
	DatabaseDSNEnv          = "MUSIC_DL_DATABASE_DSN"
	DatabaseDriverEnv       = "MUSIC_DL_DATABASE_DRIVER"
	LegacySQLiteDatabaseEnv = "MUSIC_DL_LEGACY_SQLITE_DB"
	DatabaseMaxOpenConnsEnv = "MUSIC_DL_DB_MAX_OPEN_CONNS"
	DatabaseMaxIdleConnsEnv = "MUSIC_DL_DB_MAX_IDLE_CONNS"
	DatabaseConnMaxLifeEnv  = "MUSIC_DL_DB_CONN_MAX_LIFETIME"

	defaultPostgresMaxOpenConns = 16
	defaultPostgresMaxIdleConns = 8
	defaultPostgresConnMaxLife  = 30 * time.Minute
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
		db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
		if err != nil {
			return nil, err
		}
		if err := configurePostgresPool(db); err != nil {
			return nil, err
		}
		return db, nil
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

func intEnv(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

func configurePostgresPool(db *gorm.DB) error {
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}

	maxOpen := intEnv(DatabaseMaxOpenConnsEnv, defaultPostgresMaxOpenConns)
	maxIdle := intEnv(DatabaseMaxIdleConnsEnv, defaultPostgresMaxIdleConns)
	if maxIdle > maxOpen {
		maxIdle = maxOpen
	}
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetMaxIdleConns(maxIdle)
	sqlDB.SetConnMaxLifetime(durationEnv(DatabaseConnMaxLifeEnv, defaultPostgresConnMaxLife))
	return nil
}

// IsPostgresDB checks the actual GORM dialect on an opened database.
func IsPostgresDB(db *gorm.DB) bool {
	return db != nil && strings.EqualFold(db.Dialector.Name(), "postgres")
}
