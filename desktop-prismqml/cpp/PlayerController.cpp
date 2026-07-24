#include "melodex/PlayerController.h"

#include "melodex/ApiClient.h"
#include "melodex/JsonUtils.h"
#include "melodex/Lyrics.h"
#include "melodex/UserSettings.h"

#include <QCoreApplication>
#include <QPointer>
#include <QUrl>

namespace melodex {

PlayerController::PlayerController(ApiClient *api, UserSettings *settings,
                                   QObject *parent)
    : QObject(parent),
      m_api(api),
      m_settings(settings),
      m_stateStore(settings->storagePath(QStringLiteral("playback-state.json"))),
      m_audio(new QAudioOutput(this)),
      m_player(new QMediaPlayer(this)) {
    m_audio->setVolume(0.8f);
    m_player->setAudioOutput(m_audio);
    m_saveTimer.setSingleShot(true);
    m_saveTimer.setInterval(5000);
    connect(&m_saveTimer, &QTimer::timeout, this,
            &PlayerController::flushPlaybackState);
    connect(m_player, &QMediaPlayer::playbackStateChanged, this,
            &PlayerController::onPlaybackStateChanged);
    connect(m_player, &QMediaPlayer::positionChanged, this,
            &PlayerController::onPositionChanged);
    connect(m_player, &QMediaPlayer::durationChanged, this,
            &PlayerController::onDurationChanged);
    connect(m_player, &QMediaPlayer::mediaStatusChanged, this,
            &PlayerController::onMediaStatusChanged);
    connect(m_player, &QMediaPlayer::seekableChanged, this,
            [this](bool) { applyPendingRestorePosition(); });
    connect(m_player, &QMediaPlayer::errorOccurred, this,
            [this](QMediaPlayer::Error, const QString &message) {
                setError(message.isEmpty() ? QStringLiteral("播放失败") : message);
            });
    connect(m_audio, &QAudioOutput::volumeChanged, this,
            [this](float) { emit volumeChanged(); });
    connect(m_api, &ApiClient::lyricLoaded, this, &PlayerController::applyLyrics);
    connect(m_api, &ApiClient::currentUserChanged, this,
            &PlayerController::onCurrentUserChanged);
    if (QCoreApplication::instance()) {
        connect(QCoreApplication::instance(), &QCoreApplication::aboutToQuit, this,
                &PlayerController::flushPlaybackState);
    }
}

bool PlayerController::playing() const {
    return m_player->playbackState() == QMediaPlayer::PlayingState;
}

double PlayerController::position() const { return m_player->position() / 1000.0; }

double PlayerController::duration() const { return m_player->duration() / 1000.0; }

double PlayerController::volume() const { return m_audio->volume(); }

QVariantList PlayerController::queue() const { return toVariantList(m_queue); }

double PlayerController::visualPosition() const {
    double milliseconds = static_cast<double>(m_positionAnchorMs);
    if (playing() && m_positionAnchorClock.isValid()) {
        const double playbackRate =
            qMax(0.0, static_cast<double>(m_player->playbackRate()));
        milliseconds +=
            (m_positionAnchorClock.nsecsElapsed() / 1000000.0) * playbackRate;
    }
    if (m_player->duration() > 0)
        milliseconds = qMin(milliseconds, static_cast<double>(m_player->duration()));
    return qMax(0.0, milliseconds / 1000.0);
}

int PlayerController::visualLyricIndex(double positionSeconds) const {
    return melodex::currentLyricIndex(m_lyrics, qMax(0.0, positionSeconds));
}

double PlayerController::visualLyricProgress(int index, double positionSeconds) const {
    return melodex::lyricProgress(m_lyrics, index, qMax(0.0, positionSeconds));
}

void PlayerController::playSong(const QVariantMap &songValue,
                                const QVariantList &queueValues) {
    const QVariantMap song = normalizeSong(songValue);
    if (song.value(QStringLiteral("id")).toString().isEmpty() ||
        song.value(QStringLiteral("source")).toString().isEmpty()) {
        setError(QStringLiteral("歌曲缺少来源标识，无法播放"));
        return;
    }
    savePlaybackState();
    m_pendingRestorePositionMs.reset();
    m_restoringState = false;
    m_queue.clear();
    for (const QVariant &entry : queueValues) {
        if (entry.canConvert<QVariantMap>())
            m_queue.append(normalizeSong(entry.toMap()));
    }
    m_queueIndex = -1;
    for (int index = 0; index < m_queue.size(); ++index) {
        if (songKey(m_queue.at(index)) == songKey(song)) {
            m_queueIndex = index;
            break;
        }
    }
    m_currentSong = song;
    m_lyrics.clear();
    m_currentLyricIndex = -1;
    m_currentLyricProgress = 0.0;
    setError({});
    emit queueChanged();
    emit currentSongChanged();
    emit lyricsChanged();
    emit currentLyricIndexChanged();
    emit currentLyricProgressChanged();
    requestStreamSource(song, true);
    m_api->loadLyrics(song);
    savePlaybackState(0.0);
}

void PlayerController::playQueueIndex(int index) {
    if (index < 0 || index >= m_queue.size())
        return;
    playSong(m_queue.at(index), toVariantList(m_queue));
}

void PlayerController::togglePlay() {
    if (playing()) {
        m_player->pause();
        return;
    }
    if (m_currentSong.isEmpty())
        return;
    const QString currentKey = songKey(m_currentSong);
    if (m_loadedSourceKey == currentKey)
        m_player->play();
    else if (m_pendingSourceKey == currentKey)
        m_playWhenSourceReady = true;
    else
        requestStreamSource(m_currentSong, true);
}

void PlayerController::next() {
    if (m_queue.isEmpty())
        return;
    const int nextIndex = (m_queueIndex + 1) % m_queue.size();
    playSong(m_queue.at(nextIndex), toVariantList(m_queue));
}

void PlayerController::previous() {
    if (m_queue.isEmpty())
        return;
    if (m_player->position() > 5000) {
        m_player->setPosition(0);
        return;
    }
    const int previousIndex = (m_queueIndex - 1 + m_queue.size()) % m_queue.size();
    playSong(m_queue.at(previousIndex), toVariantList(m_queue));
}

void PlayerController::seek(double seconds) {
    m_pendingRestorePositionMs.reset();
    m_restoringState = false;
    const double normalized = qMax(0.0, seconds);
    updatePositionAnchor(static_cast<qint64>(normalized * 1000.0));
    m_player->setPosition(static_cast<qint64>(normalized * 1000.0));
    savePlaybackState(normalized);
}

void PlayerController::setVolume(double value) {
    m_audio->setVolume(static_cast<float>(qBound(0.0, value, 1.0)));
}

void PlayerController::onPositionChanged(qint64 milliseconds) {
    updatePositionAnchor(milliseconds);
    emit positionChanged();
    updateLyricPosition();
    if (!m_restoringState && !m_changingSource)
        schedulePlaybackSave();
}

void PlayerController::updatePositionAnchor(qint64 milliseconds) {
    m_positionAnchorMs = qMax<qint64>(0, milliseconds);
    if (playing())
        m_positionAnchorClock.restart();
    else
        m_positionAnchorClock.invalidate();
}

void PlayerController::updateLyricPosition() {
    const int index = melodex::currentLyricIndex(m_lyrics, position());
    if (index != m_currentLyricIndex) {
        m_currentLyricIndex = index;
        emit currentLyricIndexChanged();
    }
    const double progress = lyricProgress(m_lyrics, index, position());
    if (qAbs(progress - m_currentLyricProgress) >= 0.005) {
        m_currentLyricProgress = progress;
        emit currentLyricProgressChanged();
    }
}

void PlayerController::onPlaybackStateChanged(QMediaPlayer::PlaybackState state) {
    updatePositionAnchor(m_player->position());
    emit playingChanged();
    if (state != QMediaPlayer::PlayingState && !m_changingSource)
        savePlaybackState();
}

void PlayerController::onDurationChanged(qint64) {
    emit durationChanged();
    applyPendingRestorePosition();
}

void PlayerController::onMediaStatusChanged(QMediaPlayer::MediaStatus status) {
    if (status == QMediaPlayer::LoadedMedia || status == QMediaPlayer::BufferedMedia)
        applyPendingRestorePosition();
    if (status == QMediaPlayer::EndOfMedia)
        next();
}

void PlayerController::requestStreamSource(const QVariantMap &song, bool autoplay) {
    const QString key = songKey(song);
    const quint64 serial = ++m_sourceRequestSerial;
    m_pendingSourceKey = key;
    m_loadedSourceKey.clear();
    m_playWhenSourceReady = autoplay;
    m_changingSource = true;
    m_player->stop();
    m_player->setSource({});
    m_changingSource = false;
    QPointer<PlayerController> self(this);
    m_api->requestStreamUrl(
        song, [self, serial, key](const QString &streamUrl, const QString &error) {
            if (!self || serial != self->m_sourceRequestSerial ||
                key != songKey(self->m_currentSong))
                return;
            self->m_pendingSourceKey.clear();
            if (!error.isEmpty() || streamUrl.isEmpty()) {
                self->m_playWhenSourceReady = false;
                self->m_restoringState = false;
                self->setError(error.isEmpty()
                                   ? QStringLiteral("服务端未返回原生播放地址")
                                   : error);
                return;
            }
            self->setError({});
            self->m_loadedSourceKey = key;
            self->m_changingSource = true;
            self->m_player->setSource(QUrl(streamUrl));
            self->m_changingSource = false;
            if (self->m_playWhenSourceReady) {
                self->m_playWhenSourceReady = false;
                self->m_player->play();
            }
        });
}

void PlayerController::applyPendingRestorePosition() {
    if (!m_pendingRestorePositionMs.has_value())
        return;
    if (!m_player->isSeekable() && m_player->duration() <= 0)
        return;
    qint64 target = *m_pendingRestorePositionMs;
    if (m_player->duration() > 0)
        target = qMin(target, m_player->duration());
    m_player->setPosition(target);
    m_pendingRestorePositionMs.reset();
    m_restoringState = false;
    emit positionChanged();
}

void PlayerController::applyLyrics(const QString &key, const QString &raw) {
    if (key != songKey(m_currentSong))
        return;
    m_lyrics = parseLrc(raw);
    updateLyricPosition();
    emit lyricsChanged();
}

void PlayerController::setError(const QString &message) {
    if (message == m_error)
        return;
    m_error = message;
    emit errorChanged();
}

}  // namespace melodex
