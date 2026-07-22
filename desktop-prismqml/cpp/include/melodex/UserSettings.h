#pragma once

#include <QObject>
#include <QStringList>

namespace melodex {

QString normalizeServiceUrl(const QString &rawValue);

class UserSettings final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString serviceUrl READ serviceUrl NOTIFY serviceUrlChanged)
    Q_PROPERTY(bool clickThrough READ clickThrough NOTIFY clickThroughChanged)
    Q_PROPERTY(bool lyricsVisible READ lyricsVisible NOTIFY lyricsVisibleChanged)
    Q_PROPERTY(int lyricsFontSize READ lyricsFontSize NOTIFY lyricsFontSizeChanged)
    Q_PROPERTY(int lyricsFontSizeMinimum READ lyricsFontSizeMinimum CONSTANT)
    Q_PROPERTY(int lyricsFontSizeMaximum READ lyricsFontSizeMaximum CONSTANT)
    Q_PROPERTY(QString lyricsFontFamily READ lyricsFontFamily CONSTANT)
    Q_PROPERTY(QString lyricsUnplayedColor READ lyricsUnplayedColor
                   NOTIFY lyricsColorSchemeChanged)
    Q_PROPERTY(QString lyricsPlayedColor READ lyricsPlayedColor
                   NOTIFY lyricsColorSchemeChanged)
    Q_PROPERTY(QStringList lyricsColorSchemeNames READ lyricsColorSchemeNames CONSTANT)
    Q_PROPERTY(int lyricsColorSchemeIndex READ lyricsColorSchemeIndex
                   NOTIFY lyricsColorSchemeChanged)
    Q_PROPERTY(bool lyricsPositionSet READ lyricsPositionSet NOTIFY lyricsPositionChanged)
    Q_PROPERTY(int lyricsX READ lyricsX NOTIFY lyricsPositionChanged)
    Q_PROPERTY(int lyricsY READ lyricsY NOTIFY lyricsPositionChanged)

public:
    explicit UserSettings(const QString &appName, const QString &configRoot = {},
                          QObject *parent = nullptr);

    QString serviceUrl() const { return m_serviceUrl; }
    bool clickThrough() const { return m_clickThrough; }
    bool lyricsVisible() const { return m_lyricsVisible; }
    int lyricsFontSize() const { return m_lyricsFontSize; }
    int lyricsFontSizeMinimum() const { return 20; }
    int lyricsFontSizeMaximum() const { return 64; }
    QString lyricsFontFamily() const;
    QString lyricsUnplayedColor() const;
    QString lyricsPlayedColor() const;
    QStringList lyricsColorSchemeNames() const;
    int lyricsColorSchemeIndex() const;
    bool lyricsPositionSet() const { return m_lyricsPositionSet; }
    int lyricsX() const { return m_lyricsX; }
    int lyricsY() const { return m_lyricsY; }
    QString storagePath(const QString &filename) const;

    Q_INVOKABLE bool setServiceUrl(const QString &value);
    Q_INVOKABLE void setClickThrough(bool enabled);
    Q_INVOKABLE void toggleClickThrough();
    Q_INVOKABLE void setLyricsVisible(bool visible);
    Q_INVOKABLE void toggleLyricsVisible();
    Q_INVOKABLE void setLyricsFontSize(int value);
    Q_INVOKABLE bool setLyricsColorSchemeIndex(int index);
    Q_INVOKABLE void setLyricsPosition(int x, int y);
    Q_INVOKABLE void resetLyricsPosition();

signals:
    void serviceUrlChanged();
    void clickThroughChanged();
    void lyricsVisibleChanged();
    void lyricsFontSizeChanged();
    void lyricsColorSchemeChanged();
    void lyricsPositionChanged();

private:
    void load();
    void save() const;
    QString migratedColorScheme(const QString &raw) const;

    QString m_directory;
    QString m_path;
    QString m_serviceUrl;
    bool m_clickThrough = true;
    bool m_lyricsVisible = true;
    int m_lyricsFontSize = 36;
    QString m_lyricsColorScheme = QStringLiteral("珊瑚绯");
    bool m_lyricsPositionSet = false;
    int m_lyricsX = 0;
    int m_lyricsY = 0;
};

}  // namespace melodex
