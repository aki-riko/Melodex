#include "melodex/UserSettings.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <QStandardPaths>
#include <QUrl>
#include <QVariantMap>
#include <array>
#include <stdexcept>

namespace melodex {
namespace {

struct ColorScheme {
    const char *name;
    const char *played;
    const char *unplayed;
};

constexpr std::array<ColorScheme, 8> kColorSchemes{{
    {"珊瑚绯", "#FFFFC6C6", "#FFEEEEEE"},
    {"暮霞", "#FFEEC1D1", "#FFEEEEEE"},
    {"樱雾", "#FFFDD6EB", "#FFEEEEEE"},
    {"晴澜", "#FFC7E4F1", "#FFEEEEEE"},
    {"青芽", "#FFE6FAD0", "#FFEEEEEE"},
    {"藤影", "#FFE7E3FB", "#FFEEEEEE"},
    {"杏月", "#FFFCE8C2", "#FFEEEEEE"},
    {"雾银", "#FFD3D2D2", "#FFEEEEEE"},
}};

const ColorScheme &schemeByName(const QString &name) {
    for (const ColorScheme &scheme : kColorSchemes) {
        if (QString::fromUtf8(scheme.name) == name)
            return scheme;
    }
    return kColorSchemes.front();
}

bool isLoopbackHost(const QString &host) {
    const QString lowered = host.toLower();
    return lowered == QStringLiteral("localhost") || lowered == QStringLiteral("127.0.0.1") ||
           lowered == QStringLiteral("::1");
}

}  // namespace

QString normalizeServiceUrl(const QString &rawValue) {
    QString value = rawValue.trimmed();
    if (value.isEmpty())
        throw std::invalid_argument("请填写 Melodex 服务地址");
    if (!value.contains(QStringLiteral("://")))
        value.prepend(QStringLiteral("https://"));
    QUrl url(value, QUrl::StrictMode);
    const QString scheme = url.scheme().toLower();
    if (!url.isValid() || (scheme != QStringLiteral("http") &&
                           scheme != QStringLiteral("https")) || url.host().isEmpty())
        throw std::invalid_argument("服务地址格式不正确");
    if (!url.userName().isEmpty() || !url.password().isEmpty())
        throw std::invalid_argument("服务地址不能包含账号或密码");
    if (scheme == QStringLiteral("http") && !isLoopbackHost(url.host()))
        throw std::invalid_argument("非本机服务必须使用 HTTPS");
    url.setUserInfo({});
    url.setPath(QStringLiteral("/"));
    url.setQuery({});
    url.setFragment({});
    return url.toString(QUrl::FullyEncoded);
}

UserSettings::UserSettings(const QString &appName, const QString &configRoot,
                           QObject *parent)
    : QObject(parent) {
    const QString root = configRoot.isEmpty()
                             ? QStandardPaths::writableLocation(
                                   QStandardPaths::AppConfigLocation)
                             : configRoot;
    m_directory = QDir(root).filePath(appName);
    m_path = QDir(m_directory).filePath(QStringLiteral("desktop-settings.json"));
    load();
}

void UserSettings::load() {
    QFile file(m_path);
    if (!file.exists() || !file.open(QIODevice::ReadOnly))
        return;
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        qWarning().noquote() << "[WARN] 读取桌面客户端设置失败：" << parseError.errorString();
        return;
    }
    const QJsonObject payload = document.object();
    const QString rawUrl = payload.value(QStringLiteral("service_url")).toString();
    if (!rawUrl.isEmpty()) {
        try {
            m_serviceUrl = normalizeServiceUrl(rawUrl);
        } catch (const std::invalid_argument &error) {
            qWarning().noquote() << "[WARN] 忽略无效服务地址：" << error.what();
        }
    }
    m_clickThrough = payload.value(QStringLiteral("desktop_lyrics_click_through"))
                         .toBool(true);
    m_lyricsVisible = payload.value(QStringLiteral("desktop_lyrics_visible")).toBool(true);
    const int fontSize = payload.value(QStringLiteral("desktop_lyrics_font_size")).toInt(36);
    m_lyricsFontSize = qBound(lyricsFontSizeMinimum(), fontSize, lyricsFontSizeMaximum());
    const QString rawScheme = payload.value(QStringLiteral("desktop_lyrics_color_scheme"))
                                  .toString(QStringLiteral("珊瑚绯"));
    m_lyricsColorScheme = migratedColorScheme(rawScheme);
    const bool positionSet = payload.value(QStringLiteral("desktop_lyrics_position_set"))
                                 .toBool(false);
    if (positionSet && payload.contains(QStringLiteral("desktop_lyrics_x")) &&
        payload.contains(QStringLiteral("desktop_lyrics_y"))) {
        m_lyricsPositionSet = true;
        m_lyricsX = payload.value(QStringLiteral("desktop_lyrics_x")).toInt();
        m_lyricsY = payload.value(QStringLiteral("desktop_lyrics_y")).toInt();
    }
}

QString UserSettings::migratedColorScheme(const QString &raw) const {
    static const QVariantMap legacy{
        {QStringLiteral("自定义"), QStringLiteral("珊瑚绯")},
        {QStringLiteral("网易红"), QStringLiteral("珊瑚绯")},
        {QStringLiteral("落日晖"), QStringLiteral("暮霞")},
        {QStringLiteral("可爱粉"), QStringLiteral("樱雾")},
        {QStringLiteral("天际蓝"), QStringLiteral("晴澜")},
        {QStringLiteral("清新绿"), QStringLiteral("青芽")},
        {QStringLiteral("活力紫"), QStringLiteral("藤影")},
        {QStringLiteral("温柔黄"), QStringLiteral("杏月")},
        {QStringLiteral("低调灰"), QStringLiteral("雾银")},
    };
    const QString migrated = legacy.value(raw, raw).toString();
    return lyricsColorSchemeNames().contains(migrated) ? migrated : QStringLiteral("珊瑚绯");
}

void UserSettings::save() const {
    if (!QDir().mkpath(m_directory)) {
        qWarning().noquote() << "[WARN] 无法创建桌面客户端配置目录：" << m_directory;
        return;
    }
    QJsonObject payload{
        {QStringLiteral("service_url"), m_serviceUrl},
        {QStringLiteral("desktop_lyrics_click_through"), m_clickThrough},
        {QStringLiteral("desktop_lyrics_visible"), m_lyricsVisible},
        {QStringLiteral("desktop_lyrics_font_size"), m_lyricsFontSize},
        {QStringLiteral("desktop_lyrics_color_scheme"), m_lyricsColorScheme},
        {QStringLiteral("desktop_lyrics_position_set"), m_lyricsPositionSet},
        {QStringLiteral("desktop_lyrics_x"), m_lyricsX},
        {QStringLiteral("desktop_lyrics_y"), m_lyricsY},
    };
    QSaveFile file(m_path);
    file.setDirectWriteFallback(false);
    if (!file.open(QIODevice::WriteOnly) ||
        file.write(QJsonDocument(payload).toJson(QJsonDocument::Indented)) < 0 ||
        !file.commit()) {
        qWarning().noquote() << "[WARN] 保存桌面客户端设置失败：" << file.errorString();
    }
#ifndef Q_OS_WIN
    QFile::setPermissions(m_path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
#endif
}

QString UserSettings::lyricsFontFamily() const {
#ifdef Q_OS_MACOS
    return QStringLiteral("PingFang SC");
#else
    return QStringLiteral("Microsoft YaHei UI");
#endif
}

QString UserSettings::lyricsUnplayedColor() const {
    return QString::fromLatin1(schemeByName(m_lyricsColorScheme).unplayed);
}

QString UserSettings::lyricsPlayedColor() const {
    return QString::fromLatin1(schemeByName(m_lyricsColorScheme).played);
}

QStringList UserSettings::lyricsColorSchemeNames() const {
    QStringList names;
    for (const ColorScheme &scheme : kColorSchemes)
        names.append(QString::fromUtf8(scheme.name));
    return names;
}

int UserSettings::lyricsColorSchemeIndex() const {
    return lyricsColorSchemeNames().indexOf(m_lyricsColorScheme);
}

QString UserSettings::storagePath(const QString &filename) const {
    return QDir(m_directory).filePath(filename);
}

bool UserSettings::setServiceUrl(const QString &value) {
    const QString normalized = normalizeServiceUrl(value);
    if (normalized == m_serviceUrl)
        return true;
    m_serviceUrl = normalized;
    save();
    emit serviceUrlChanged();
    return true;
}

void UserSettings::setClickThrough(bool enabled) {
    if (enabled == m_clickThrough)
        return;
    m_clickThrough = enabled;
    save();
    emit clickThroughChanged();
}

void UserSettings::toggleClickThrough() { setClickThrough(!m_clickThrough); }

void UserSettings::setLyricsVisible(bool visible) {
    if (visible == m_lyricsVisible)
        return;
    m_lyricsVisible = visible;
    save();
    emit lyricsVisibleChanged();
}

void UserSettings::toggleLyricsVisible() { setLyricsVisible(!m_lyricsVisible); }

void UserSettings::setLyricsFontSize(int value) {
    const int normalized = qBound(lyricsFontSizeMinimum(), value, lyricsFontSizeMaximum());
    if (normalized == m_lyricsFontSize)
        return;
    m_lyricsFontSize = normalized;
    save();
    emit lyricsFontSizeChanged();
}

bool UserSettings::setLyricsColorSchemeIndex(int index) {
    const QStringList names = lyricsColorSchemeNames();
    if (index < 0 || index >= names.size()) {
        qWarning() << "[WARN] 拒绝无效桌面歌词配色索引：" << index;
        return false;
    }
    if (names.at(index) == m_lyricsColorScheme)
        return true;
    m_lyricsColorScheme = names.at(index);
    save();
    emit lyricsColorSchemeChanged();
    return true;
}

void UserSettings::setLyricsPosition(int x, int y) {
    if (m_lyricsPositionSet && x == m_lyricsX && y == m_lyricsY)
        return;
    m_lyricsPositionSet = true;
    m_lyricsX = x;
    m_lyricsY = y;
    save();
    emit lyricsPositionChanged();
}

void UserSettings::resetLyricsPosition() {
    if (!m_lyricsPositionSet)
        return;
    m_lyricsPositionSet = false;
    m_lyricsX = 0;
    m_lyricsY = 0;
    save();
    emit lyricsPositionChanged();
}

}  // namespace melodex
