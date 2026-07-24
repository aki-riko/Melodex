#include "melodex/PlayerController.h"

#include "melodex/ApiClient.h"
#include "melodex/JsonUtils.h"
#include "melodex/UserSettings.h"

namespace melodex {

void PlayerController::onCurrentUserChanged() {
    savePlaybackState();
    m_saveTimer.stop();
    m_activeIdentity.reset();
    clearPlayback();
    const auto identity = authenticatedIdentity();
    if (!identity.has_value())
        return;
    m_activeIdentity = identity;
    restorePlaybackState();
}

std::optional<QPair<QString, QString>> PlayerController::authenticatedIdentity() const {
    if (!m_api->authenticated())
        return std::nullopt;
    const QString userId = m_api->currentUser().value(QStringLiteral("id")).toString().trimmed();
    const QString serviceUrl = m_settings->serviceUrl().trimmed();
    if (serviceUrl.isEmpty() || userId.isEmpty() || userId == QStringLiteral("0")) {
        qWarning() << "[WARN] 已认证会话缺少服务地址或用户 ID，无法恢复播放状态";
        return std::nullopt;
    }
    return QPair<QString, QString>{serviceUrl, userId};
}

void PlayerController::restorePlaybackState() {
    if (!m_activeIdentity.has_value())
        return;
    const auto snapshot = m_stateStore.load(m_activeIdentity->first,
                                            m_activeIdentity->second);
    if (!snapshot.has_value())
        return;
    const QVariantMap current = normalizeSong(
        snapshot->value(QStringLiteral("current_song")).toMap());
    if (current.value(QStringLiteral("id")).toString().isEmpty() ||
        current.value(QStringLiteral("source")).toString().isEmpty()) {
        qWarning() << "[WARN] 忽略来源标识不完整的桌面播放状态";
        return;
    }
    QList<QVariantMap> queue;
    for (const QVariantMap &item : variantMaps(snapshot->value(QStringLiteral("queue")))) {
        const QVariantMap normalized = normalizeSong(item);
        if (!normalized.value(QStringLiteral("id")).toString().isEmpty() &&
            !normalized.value(QStringLiteral("source")).toString().isEmpty())
            queue.append(normalized);
    }
    const int queueIndex = restoredQueueIndex(
        queue, snapshot->value(QStringLiteral("queue_index"), -1).toInt(), current);
    const qint64 positionMs = restoredPositionMs(
        snapshot->value(QStringLiteral("position_seconds")), current);

    m_currentSong = current;
    m_queue = queue;
    m_queueIndex = queueIndex;
    m_lyrics.clear();
    m_currentLyricIndex = -1;
    m_currentLyricProgress = 0.0;
    m_pendingRestorePositionMs = positionMs;
    m_restoringState = positionMs > 0;
    setError({});
    emit queueChanged();
    emit currentSongChanged();
    emit lyricsChanged();
    emit currentLyricIndexChanged();
    emit currentLyricProgressChanged();
    requestStreamSource(current, false);
    m_api->loadLyrics(current);
    if (positionMs == 0) {
        m_pendingRestorePositionMs.reset();
        emit positionChanged();
    }
}

int PlayerController::restoredQueueIndex(const QList<QVariantMap> &queue,
                                         int rawIndex,
                                         const QVariantMap &currentSong) const {
    const QString currentKey = songKey(currentSong);
    if (rawIndex >= 0 && rawIndex < queue.size() &&
        songKey(queue.at(rawIndex)) == currentKey)
        return rawIndex;
    for (int index = 0; index < queue.size(); ++index) {
        if (songKey(queue.at(index)) == currentKey)
            return index;
    }
    return -1;
}

qint64 PlayerController::restoredPositionMs(const QVariant &rawPosition,
                                            const QVariantMap &song) const {
    bool ok = false;
    double restored = rawPosition.toDouble(&ok);
    if (!ok || restored < 0.0)
        restored = 0.0;
    const double songDuration = qMax(
        0.0, song.value(QStringLiteral("duration")).toDouble());
    if (songDuration > 0.0)
        restored = qMin(restored, songDuration);
    return static_cast<qint64>(restored * 1000.0);
}

void PlayerController::schedulePlaybackSave() {
    if (m_activeIdentity.has_value() && !m_currentSong.isEmpty() &&
        !m_saveTimer.isActive())
        m_saveTimer.start();
}

void PlayerController::flushPlaybackState() { savePlaybackState(); }

void PlayerController::savePlaybackState(std::optional<double> positionSeconds) {
    m_saveTimer.stop();
    if (!m_activeIdentity.has_value() || m_currentSong.isEmpty())
        return;
    if (!positionSeconds.has_value()) {
        positionSeconds = m_pendingRestorePositionMs.has_value()
                              ? *m_pendingRestorePositionMs / 1000.0
                              : position();
    }
    const QVariantMap snapshot{
        {QStringLiteral("current_song"), m_currentSong},
        {QStringLiteral("queue"), toVariantList(m_queue)},
        {QStringLiteral("queue_index"), m_queueIndex},
        {QStringLiteral("position_seconds"), qMax(0.0, *positionSeconds)},
    };
    m_stateStore.save(m_activeIdentity->first, m_activeIdentity->second, snapshot);
}

void PlayerController::clearPlayback() {
    ++m_sourceRequestSerial;
    m_pendingSourceKey.clear();
    m_loadedSourceKey.clear();
    m_playWhenSourceReady = false;
    m_pendingRestorePositionMs.reset();
    m_restoringState = false;
    m_changingSource = true;
    m_player->stop();
    m_player->setSource({});
    m_changingSource = false;
    m_currentSong.clear();
    m_queue.clear();
    m_queueIndex = -1;
    m_lyrics.clear();
    m_currentLyricIndex = -1;
    m_currentLyricProgress = 0.0;
    setError({});
    emit queueChanged();
    emit currentSongChanged();
    emit positionChanged();
    emit durationChanged();
    emit lyricsChanged();
    emit currentLyricIndexChanged();
    emit currentLyricProgressChanged();
}

}  // namespace melodex
