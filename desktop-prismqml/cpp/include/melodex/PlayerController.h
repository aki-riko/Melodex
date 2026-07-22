#pragma once

#include <QAudioOutput>
#include <QMediaPlayer>
#include <QObject>
#include <QTimer>
#include <QVariantList>
#include <QVariantMap>
#include <optional>

#include "melodex/PlaybackStateStore.h"

namespace melodex {

class ApiClient;
class UserSettings;

class PlayerController final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantMap currentSong READ currentSong NOTIFY currentSongChanged)
    Q_PROPERTY(bool playing READ playing NOTIFY playingChanged)
    Q_PROPERTY(double position READ position NOTIFY positionChanged)
    Q_PROPERTY(double duration READ duration NOTIFY durationChanged)
    Q_PROPERTY(double volume READ volume NOTIFY volumeChanged)
    Q_PROPERTY(QVariantList lyrics READ lyrics NOTIFY lyricsChanged)
    Q_PROPERTY(int currentLyricIndex READ currentLyricIndex
                   NOTIFY currentLyricIndexChanged)
    Q_PROPERTY(double currentLyricProgress READ currentLyricProgress
                   NOTIFY currentLyricProgressChanged)
    Q_PROPERTY(bool hasLyrics READ hasLyrics NOTIFY lyricsChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    explicit PlayerController(ApiClient *api, UserSettings *settings,
                              QObject *parent = nullptr);

    QVariantMap currentSong() const { return m_currentSong; }
    bool playing() const;
    double position() const;
    double duration() const;
    double volume() const;
    QVariantList lyrics() const { return m_lyrics; }
    int currentLyricIndex() const { return m_currentLyricIndex; }
    double currentLyricProgress() const { return m_currentLyricProgress; }
    bool hasLyrics() const { return !m_currentSong.isEmpty() && !m_lyrics.isEmpty(); }
    QString error() const { return m_error; }
    QMediaPlayer *mediaPlayer() const { return m_player; }

    Q_INVOKABLE void playSong(const QVariantMap &song, const QVariantList &queue);
    Q_INVOKABLE void togglePlay();
    Q_INVOKABLE void next();
    Q_INVOKABLE void previous();
    Q_INVOKABLE void seek(double seconds);
    Q_INVOKABLE void setVolume(double volume);
    Q_INVOKABLE void flushPlaybackState();

signals:
    void currentSongChanged();
    void playingChanged();
    void positionChanged();
    void durationChanged();
    void volumeChanged();
    void lyricsChanged();
    void currentLyricIndexChanged();
    void currentLyricProgressChanged();
    void errorChanged();

private slots:
    void onPositionChanged(qint64 milliseconds);
    void onPlaybackStateChanged(QMediaPlayer::PlaybackState state);
    void onDurationChanged(qint64 milliseconds);
    void onMediaStatusChanged(QMediaPlayer::MediaStatus status);
    void onCurrentUserChanged();
    void applyLyrics(const QString &key, const QString &raw);

private:
    void requestStreamSource(const QVariantMap &song, bool autoplay);
    void setError(const QString &message);
    void updateLyricPosition();
    void applyPendingRestorePosition();
    void schedulePlaybackSave();
    void savePlaybackState(std::optional<double> positionSeconds = std::nullopt);
    void restorePlaybackState();
    void clearPlayback();
    std::optional<QPair<QString, QString>> authenticatedIdentity() const;
    int restoredQueueIndex(const QList<QVariantMap> &queue, int rawIndex,
                           const QVariantMap &currentSong) const;
    qint64 restoredPositionMs(const QVariant &rawPosition,
                             const QVariantMap &song) const;

    ApiClient *m_api = nullptr;
    UserSettings *m_settings = nullptr;
    PlaybackStateStore m_stateStore;
    QAudioOutput *m_audio = nullptr;
    QMediaPlayer *m_player = nullptr;
    QVariantMap m_currentSong;
    QList<QVariantMap> m_queue;
    int m_queueIndex = -1;
    QVariantList m_lyrics;
    int m_currentLyricIndex = -1;
    double m_currentLyricProgress = 0.0;
    QString m_error;
    std::optional<QPair<QString, QString>> m_activeIdentity;
    std::optional<qint64> m_pendingRestorePositionMs;
    bool m_restoringState = false;
    quint64 m_sourceRequestSerial = 0;
    QString m_pendingSourceKey;
    QString m_loadedSourceKey;
    bool m_playWhenSourceReady = false;
    bool m_changingSource = false;
    QTimer m_saveTimer;
};

}  // namespace melodex
