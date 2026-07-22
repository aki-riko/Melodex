// SPDX-License-Identifier: AGPL-3.0-only
#include "melodex/ApiClient.h"
#include "melodex/CookieStore.h"
#include "melodex/PlayerController.h"
#include "melodex/UserSettings.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QMediaPlayer>
#include <QTemporaryDir>
#include <QThread>
#include <QTextStream>
#include <QTimer>
#include <memory>

namespace {

int argumentInt(const QStringList &arguments, int index, int fallback) {
    bool ok = false;
    const int value = arguments.value(index).toInt(&ok);
    return ok && value > 0 ? value : fallback;
}

void printProbeStatus(const QString &message) {
    QTextStream stream(stdout);
    stream << message << Qt::endl;
}

}  // namespace

int main(int argc, char *argv[]) {
    qputenv("QT_LOGGING_RULES",
            "qt.multimedia.ffmpeg=false;qt.multimedia.ffmpeg.*=false");
    QCoreApplication application(argc, argv);
    const QStringList arguments = application.arguments();
    if (arguments.size() < 5) {
        qCritical() << "用法: melodex_playback_probe <服务URL> <关键词> <来源> <歌曲ID>"
                       " [最少播放秒数] [超时秒数]";
        return 2;
    }

    const QString serviceUrl = arguments.at(1);
    const QString keyword = arguments.at(2);
    const QString expectedSource = arguments.at(3);
    const QString expectedId = arguments.at(4);
    const int minimumSeconds = argumentInt(arguments, 5, 8);
    const int timeoutSeconds = argumentInt(arguments, 6, 90);
    const QString configuredRoot =
        qEnvironmentVariable("MELODEX_PROBE_CONFIG_ROOT").trimmed();
    std::unique_ptr<QTemporaryDir> temporaryRoot;
    QString configRoot = configuredRoot;
    QString settingsName = QStringLiteral("Melodex");
    if (configRoot.isEmpty()) {
        temporaryRoot = std::make_unique<QTemporaryDir>();
        if (!temporaryRoot->isValid()) {
            qCritical() << "PLAYBACK_PROBE_FAIL: 无法创建隔离配置目录";
            return 3;
        }
        configRoot = temporaryRoot->path();
        settingsName = QStringLiteral("MelodexProbe");
    }

    melodex::UserSettings settings(settingsName, configRoot);
    settings.setServiceUrl(serviceUrl);
    melodex::CookieStore cookies(
        settings.storagePath(QStringLiteral("cookies.dat")));
    melodex::ApiClient api(&settings, &cookies);
    melodex::PlayerController player(&api, &settings);
    player.setVolume(0.0);

    int result = 4;
    qint64 maximumPosition = 0;
    QElapsedTimer playbackClock;
    QTimer stressTimer;
    stressTimer.setInterval(250);
    QObject::connect(&stressTimer, &QTimer::timeout, &application,
                     []() { QThread::msleep(80); });
    QObject::connect(&api, &melodex::ApiClient::authenticatedChanged,
                     &application, [&]() {
                         if (!api.authenticated()) {
                             qCritical() << "PLAYBACK_PROBE_FAIL: 本地会话未认证";
                             application.exit(5);
                             return;
                         }
                         api.search(keyword);
                     });
    QObject::connect(&api, &melodex::ApiClient::searchResultsChanged,
                     &application, [&]() {
                         const QVariantList results = api.searchResults();
                         for (const QVariant &entry : results) {
                             const QVariantMap song = entry.toMap();
                             if (song.value(QStringLiteral("source")).toString() !=
                                     expectedSource ||
                                 song.value(QStringLiteral("id")).toString() != expectedId)
                                 continue;
                             printProbeStatus(QStringLiteral(
                                 "PLAYBACK_PROBE_REAL_SONG %1 %2 %3 %4")
                                                  .arg(
                                                      song.value(QStringLiteral("source"))
                                                          .toString(),
                                                      song.value(QStringLiteral("id"))
                                                          .toString(),
                                                      song.value(QStringLiteral("name"))
                                                          .toString(),
                                                      song.value(QStringLiteral("artist"))
                                                          .toString()));
                             player.playSong(song, results);
                             return;
                         }
                         qCritical() << "PLAYBACK_PROBE_FAIL: 真实搜索结果未找到目标歌曲";
                         application.exit(6);
                     });
    QObject::connect(player.mediaPlayer(), &QMediaPlayer::playbackStateChanged,
                     &application, [&](QMediaPlayer::PlaybackState state) {
                         if (state == QMediaPlayer::PlayingState && !playbackClock.isValid()) {
                             playbackClock.start();
                             stressTimer.start();
                             printProbeStatus(QStringLiteral("PLAYBACK_PROBE_PLAYING"));
                         }
                     });
    QObject::connect(player.mediaPlayer(), &QMediaPlayer::positionChanged,
                     &application, [&](qint64 position) {
                         maximumPosition = qMax(maximumPosition, position);
                         if (position < static_cast<qint64>(minimumSeconds) * 1000)
                             return;
                         stressTimer.stop();
                         const qint64 wallMilliseconds = playbackClock.elapsed();
                         const qint64 allowedWallMilliseconds =
                             static_cast<qint64>(minimumSeconds) * 1000 + 5000;
                         if (wallMilliseconds > allowedWallMilliseconds) {
                             qCritical() << "PLAYBACK_PROBE_FAIL: 主线程受压时媒体进度落后"
                                         << "position_ms=" << position
                                         << "wall_ms=" << wallMilliseconds;
                             application.exit(7);
                             return;
                         }
                         printProbeStatus(
                             QStringLiteral("PLAYBACK_PROBE_OK position_ms=%1 wall_ms=%2")
                                 .arg(position)
                                 .arg(wallMilliseconds));
                         result = 0;
                         application.quit();
                     });
    QObject::connect(&player, &melodex::PlayerController::errorChanged,
                     &application, [&]() {
                         if (player.error().isEmpty())
                             return;
                         qCritical().noquote() << "PLAYBACK_PROBE_FAIL:" << player.error();
                         application.exit(8);
                     });
    QTimer::singleShot(timeoutSeconds * 1000, &application, [&]() {
        qCritical() << "PLAYBACK_PROBE_FAIL: 超时"
                    << "maximum_position_ms=" << maximumPosition;
        application.exit(9);
    });

    api.checkSession();
    const int eventResult = application.exec();
    return result == 0 ? 0 : eventResult;
}
