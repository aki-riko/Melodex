package web

import (
	"errors"
	"strings"
	"time"

	"github.com/guohuiyuan/go-music-dl/core"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// 用户角色:两级 RBAC。
//   - RoleAdmin:管理员/ROOT,可管理用户、改系统设置、设置各源 cookie。
//   - RoleUser:普通用户,只能管理自己的歌单/收藏/下载与个人偏好。
const (
	RoleAdmin = "admin"
	RoleUser  = "user"

	minUsernameLen = 2
	maxUsernameLen = 32
)

var (
	// ErrUserNotFound 查无此用户。
	ErrUserNotFound = errors.New("用户不存在")
	// ErrUsernameTaken 用户名已被占用。
	ErrUsernameTaken = errors.New("用户名已存在")
	// ErrInvalidUsername 用户名不合法。
	ErrInvalidUsername = errors.New("用户名不合法")
	// ErrInvalidPassword 密码不满足最小长度。
	ErrInvalidPassword = errors.New("密码不合法")
	// ErrLastRootProtected 不能删除/降级最后一个管理员。
	ErrLastRootProtected = errors.New("系统至少保留一个管理员")
)

// User 是 Melodex 的登录账号。歌单/收藏/下载归属、个人偏好都挂在 user_id 上。
// 密码以 bcrypt 哈希存储,绝不回显明文或哈希。
type User struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"uniqueIndex;not null" json:"username"`
	PasswordHash string    `gorm:"not null" json:"-"`
	Role         string    `gorm:"not null;default:user" json:"role"`
	Disabled     bool      `gorm:"not null;default:false" json:"disabled"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// publicUser 是返回给前端的脱敏视图(不含任何凭据字段)。
type publicUser struct {
	ID        uint      `json:"id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	Disabled  bool      `json:"disabled"`
	CreatedAt time.Time `json:"created_at"`
}

func (u User) public() publicUser {
	return publicUser{
		ID:        u.ID,
		Username:  u.Username,
		Role:      u.normalizedRole(),
		Disabled:  u.Disabled,
		CreatedAt: u.CreatedAt,
	}
}

func (u User) normalizedRole() string {
	if strings.TrimSpace(u.Role) == RoleAdmin {
		return RoleAdmin
	}
	return RoleUser
}

func (u User) isAdmin() bool {
	return u.normalizedRole() == RoleAdmin
}

// normalizeUsername 统一用户名:去空白。用户名大小写敏感按原样存储,
// 但唯一性与登录比对都用小写,避免出现 "Admin"/"admin" 两个账号。
func normalizeUsername(raw string) string {
	return strings.TrimSpace(raw)
}

func usernameKey(raw string) string {
	return strings.ToLower(normalizeUsername(raw))
}

func validateUsername(raw string) (string, error) {
	name := normalizeUsername(raw)
	if n := len([]rune(name)); n < minUsernameLen || n > maxUsernameLen {
		return "", ErrInvalidUsername
	}
	// 不允许内含空白(避免与 SSO header / 显示混淆)。
	if strings.ContainsAny(name, " \t\r\n") {
		return "", ErrInvalidUsername
	}
	return name, nil
}

func hashPassword(password string) (string, error) {
	if len(password) < minAuthPasswordSize {
		return "", ErrInvalidPassword
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// countUsers 返回用户总数(用于判断是否首次初始化)。
func countUsers() (int64, error) {
	var n int64
	if err := db.Model(&User{}).Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}

// countAdmins 返回未禁用的管理员数量(用于保护最后一个管理员)。
func countAdmins(excludeID uint) (int64, error) {
	var n int64
	q := db.Model(&User{}).Where("role = ? AND disabled = ?", RoleAdmin, false)
	if excludeID != 0 {
		q = q.Where("id <> ?", excludeID)
	}
	if err := q.Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}

func findUserByID(id uint) (*User, error) {
	var u User
	if err := db.First(&u, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return &u, nil
}

// findUserByUsername 按用户名(大小写不敏感)查用户。
func findUserByUsername(username string) (*User, error) {
	var u User
	key := usernameKey(username)
	if key == "" {
		return nil, ErrUserNotFound
	}
	if err := db.Where("LOWER(username) = ?", key).First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return &u, nil
}

// usernameExists 大小写不敏感判断用户名是否已存在(不触发 record-not-found 日志)。
func usernameExists(username string) (bool, error) {
	key := usernameKey(username)
	if key == "" {
		return false, nil
	}
	var n int64
	if err := db.Model(&User{}).Where("LOWER(username) = ?", key).Count(&n).Error; err != nil {
		return false, err
	}
	return n > 0, nil
}

// createUser 新建账号。username 校验 + 唯一性(大小写不敏感)+ 密码哈希。
func createUser(username, password, role string) (*User, error) {
	name, err := validateUsername(username)
	if err != nil {
		return nil, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return nil, err
	}

	if exists, err := usernameExists(name); err != nil {
		return nil, err
	} else if exists {
		return nil, ErrUsernameTaken
	}

	normalizedRole := RoleUser
	if strings.TrimSpace(role) == RoleAdmin {
		normalizedRole = RoleAdmin
	}

	u := User{
		Username:     name,
		PasswordHash: hash,
		Role:         normalizedRole,
	}
	if err := db.Create(&u).Error; err != nil {
		// 唯一索引兜底(并发创建)。
		if isUniqueConstraintErr(err) {
			return nil, ErrUsernameTaken
		}
		return nil, err
	}
	return &u, nil
}

// setUserPassword 重置某用户密码(管理员操作或自助改密)。
func setUserPassword(id uint, password string) error {
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	res := db.Model(&User{}).Where("id = ?", id).Update("password_hash", hash)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrUserNotFound
	}
	return nil
}

// setUserRole 改角色。降级管理员时保护最后一个管理员。
func setUserRole(id uint, role string) error {
	target := RoleUser
	if strings.TrimSpace(role) == RoleAdmin {
		target = RoleAdmin
	}
	u, err := findUserByID(id)
	if err != nil {
		return err
	}
	if u.isAdmin() && target != RoleAdmin {
		others, err := countAdmins(u.ID)
		if err != nil {
			return err
		}
		if others == 0 {
			return ErrLastRootProtected
		}
	}
	return db.Model(&User{}).Where("id = ?", id).Update("role", target).Error
}

// setUserDisabled 启用/禁用账号。禁用最后一个管理员时保护。
func setUserDisabled(id uint, disabled bool) error {
	u, err := findUserByID(id)
	if err != nil {
		return err
	}
	if disabled && u.isAdmin() {
		others, err := countAdmins(u.ID)
		if err != nil {
			return err
		}
		if others == 0 {
			return ErrLastRootProtected
		}
	}
	return db.Model(&User{}).Where("id = ?", id).Update("disabled", disabled).Error
}

// deleteUser 删除账号。保护最后一个管理员。删除前应处理其归属数据(调用方负责)。
func deleteUser(id uint) error {
	u, err := findUserByID(id)
	if err != nil {
		return err
	}
	if u.isAdmin() {
		others, err := countAdmins(u.ID)
		if err != nil {
			return err
		}
		if others == 0 {
			return ErrLastRootProtected
		}
	}
	return db.Delete(&User{}, id).Error
}

func listUsers() ([]publicUser, error) {
	var users []User
	if err := db.Order("id ASC").Find(&users).Error; err != nil {
		return nil, err
	}
	out := make([]publicUser, 0, len(users))
	for _, u := range users {
		out = append(out, u.public())
	}
	return out, nil
}

// verifyPassword 校验明文密码与哈希是否匹配。
func verifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func isUniqueConstraintErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unique") || strings.Contains(msg, "constraint")
}

// migrateRootUserAndOwnership 在 InitDB 内幂等执行,完成单管理员 → 多用户的迁移:
//  1. 若已存在用户:仅把 user_id=0 的孤儿 collection 归给最早的管理员(或最早用户)。
//  2. 若尚无用户但旧的 WebAuthSettings 已配置过管理员账号(已 setup 的单 admin):
//     用它的用户名/密码哈希创建 ROOT(role=admin),并把全部存量 collection 归给它。
//  3. 若既无用户也无旧账号(全新部署):不创建任何用户,等首次 setup 走 register 流程。
//
// 绝不在迁移里凭空造管理员密码——只复用已有的密码哈希,避免产生未知凭据的后门账号。
func migrateRootUserAndOwnership() error {
	count, err := countUsers()
	if err != nil {
		return err
	}

	if count == 0 {
		legacy, err := core.GetWebAuthSettings()
		if err != nil {
			return err
		}
		// 旧账号已完成 setup(用户名+密码哈希齐全)才迁移成 ROOT。
		if strings.TrimSpace(legacy.Username) != "" && strings.TrimSpace(legacy.PasswordHash) != "" {
			root := User{
				Username:     normalizeUsername(legacy.Username),
				PasswordHash: strings.TrimSpace(legacy.PasswordHash),
				Role:         RoleAdmin,
			}
			if err := db.Create(&root).Error; err != nil {
				return err
			}
			// 全部存量 collection 归 ROOT。
			if err := db.Model(&Collection{}).Where("user_id = 0 OR user_id IS NULL").
				Update("user_id", root.ID).Error; err != nil {
				return err
			}
		}
		return nil
	}

	// 已有用户:把孤儿 collection(老数据没 user_id)归给最早的管理员,无管理员则归最早用户。
	var owner User
	if err := db.Where("role = ?", RoleAdmin).Order("id ASC").First(&owner).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if err := db.Order("id ASC").First(&owner).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return nil
				}
				return err
			}
		} else {
			return err
		}
	}
	return db.Model(&Collection{}).Where("user_id = 0 OR user_id IS NULL").
		Update("user_id", owner.ID).Error
}


