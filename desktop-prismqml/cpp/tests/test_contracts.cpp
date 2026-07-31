// SPDX-License-Identifier: AGPL-3.0-only
#include "melodex/ApiClient.h"
#include "melodex/ApplicationConfig.h"
#include "melodex/CookieStore.h"
#include "melodex/JsonUtils.h"
#include "melodex/Lyrics.h"
#include "melodex/PlaybackStateStore.h"
#include "melodex/PlayerController.h"
#include "melodex/UserSettings.h"

#include <QTemporaryDir>
#include <QTest>
#include <QUrlQuery>
#include <stdexcept>

class DesktopContractsTest final : public QObject {
    Q_OBJECT

private slots:
    void applicationConfigLoadsPackagedContract();
    void serviceUrlRejectsUnsafeOrigins();
    void playbackUrlStaysOnAuthenticatedOrigin();
    void realSongMetadataNormalizesForRequests();
    void qqZeroSongMidUsesNumericSongId();
    void coverUrlUsesSharedQmlNetworkStack();
    void invalidQqAlbumCoverFallsBackWithoutRequest();
    void playerPublishesQueueContractToQml();
    void lyricsSupportWordAndLineTiming();
    void lyricsKeepProductionSameTimestampOrder();
    void lyricsTypographySupportsPersistedCjkFontPresets();
    void playbackStateIsAccountScoped();
    void playbackRestoreWaitsForSeekableStream();
    void playbackRestoreRemainsVisibleUntilPlayerConfirmsSeek();
    void playbackRestoreDoesNotRestartAnOutstandingSeek();
};

void DesktopContractsTest::applicationConfigLoadsPackagedContract() {
    const melodex::ApplicationConfig config =
        melodex::loadApplicationConfig(QStringLiteral(":/Melodex/app_config.json"));
    QCOMPARE(config.applicationName, QStringLiteral("Melodex"));
    QCOMPARE(config.applicationId, QStringLiteral("PrismQML.Melodex"));
    QCOMPARE(config.applicationDescription,
             QStringLiteral("全网音乐搜索、播放与下载客户端"));
    QCOMPARE(config.projectHomepage,
             QStringLiteral("https://github.com/aki-riko/Melodex"));
    QCOMPARE(config.frameworkHomepage,
             QStringLiteral("https://github.com/aki-riko/PrismQML"));
    QVERIFY(config.window.minimumWidth > 0);
}

void DesktopContractsTest::serviceUrlRejectsUnsafeOrigins() {
    QCOMPARE(melodex::normalizeServiceUrl(QStringLiteral("music.example.test")),
             QStringLiteral("https://music.example.test/"));
    QCOMPARE(melodex::normalizeServiceUrl(QStringLiteral("http://127.0.0.1:8329/api")),
             QStringLiteral("http://127.0.0.1:8329/"));
    QVERIFY_THROWS_EXCEPTION(
        std::invalid_argument,
        melodex::normalizeServiceUrl(QStringLiteral("http://music.example.test")));
    QVERIFY_THROWS_EXCEPTION(
        std::invalid_argument,
        melodex::normalizeServiceUrl(QStringLiteral("https://user:pass@example.test")));
}

void DesktopContractsTest::playbackUrlStaysOnAuthenticatedOrigin() {
    const QUrl url = melodex::resolvePlaybackUrl(
        QStringLiteral("https://music.example.test/"),
        QStringLiteral("/music/playback/2140404278?ticket=signed"));
    QCOMPARE(url.host(), QStringLiteral("music.example.test"));
    QCOMPARE(url.path(), QStringLiteral("/music/playback/2140404278"));
    QVERIFY_THROWS_EXCEPTION(
        std::invalid_argument,
        melodex::resolvePlaybackUrl(QStringLiteral("https://music.example.test/"),
                                    QStringLiteral("https://evil.example/audio.mp3")));
}

void DesktopContractsTest::realSongMetadataNormalizesForRequests() {
    const QVariantMap song = {
        {QStringLiteral("ID"), QStringLiteral("2140404278")},
        {QStringLiteral("Source"), QStringLiteral("NETEASE")},
        {QStringLiteral("Name"), QStringLiteral("海棠又落微雨时")},
        {QStringLiteral("Artist"), QStringLiteral("" )},
        {QStringLiteral("Duration"), 245.5},
    };
    const QVariantMap normalized = melodex::normalizeSong(song);
    QCOMPARE(normalized.value(QStringLiteral("id")).toString(),
             QStringLiteral("2140404278"));
    QCOMPARE(normalized.value(QStringLiteral("source")).toString(),
             QStringLiteral("netease"));
    QCOMPARE(melodex::songKey(normalized), QStringLiteral("netease:2140404278"));
    QVERIFY(melodex::encodedQuery(melodex::songQuery(normalized))
                .contains(QStringLiteral("id=2140404278")));
}

void DesktopContractsTest::qqZeroSongMidUsesNumericSongId() {
    const QVariantMap song = {
        {QStringLiteral("id"), QStringLiteral("0")},
        {QStringLiteral("source"), QStringLiteral("qq")},
        {QStringLiteral("name"), QStringLiteral("晚安")},
        {QStringLiteral("artist"), QStringLiteral("许莉洁")},
        {QStringLiteral("duration"), 283},
        {QStringLiteral("extra"),
         QVariantMap{{QStringLiteral("songmid"), QStringLiteral("0")},
                     {QStringLiteral("song_id"), QStringLiteral("613053895")}}},
    };

    const QVariantMap normalized = melodex::normalizeSong(song);
    QCOMPARE(normalized.value(QStringLiteral("id")).toString(),
             QStringLiteral("613053895"));
    QCOMPARE(melodex::songKey(normalized), QStringLiteral("qq:613053895"));
    const QString query = melodex::encodedQuery(melodex::songQuery(normalized));
    QVERIFY(query.contains(QStringLiteral("id=613053895")));
    QVERIFY(query.contains(QStringLiteral("source=qq")));
}

void DesktopContractsTest::coverUrlUsesSharedQmlNetworkStack() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    melodex::UserSettings settings(QStringLiteral("MelodexCoverTest"),
                                   directory.path());
    QVERIFY(settings.setServiceUrl(QStringLiteral("https://music.example.test/")));
    melodex::CookieStore cookies(directory.filePath(QStringLiteral("cookies.dat")));
    melodex::ApiClient api(&settings, &cookies);
    const QString remoteCover = QStringLiteral(
        "http://p1.music.126.net/8C0lwLE88j9ZwLyPQ9a4FA==/109951165595770076.jpg");
    const QString encodedUrl = api.coverUrl({
        {QStringLiteral("id"), QStringLiteral("song-1")},
        {QStringLiteral("source"), QStringLiteral("netease")},
        {QStringLiteral("cover"), remoteCover},
    });
    QVERIFY(encodedUrl.contains(QStringLiteral("url=http%3A%2F%2F")));
    QVERIFY(!encodedUrl.contains(QStringLiteral("url=http://")));

    const QUrl url(encodedUrl);

    QCOMPARE(url.scheme(), QStringLiteral("https"));
    QCOMPARE(url.host(), QStringLiteral("music.example.test"));
    QCOMPARE(url.path(), QStringLiteral("/music/cover_proxy"));
    const QUrlQuery query(url);
    QCOMPARE(query.queryItemValue(QStringLiteral("url"), QUrl::FullyDecoded), remoteCover);
    QCOMPARE(query.queryItemValue(QStringLiteral("source")), QStringLiteral("netease"));
}

void DesktopContractsTest::invalidQqAlbumCoverFallsBackWithoutRequest() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    melodex::UserSettings settings(QStringLiteral("MelodexInvalidCoverTest"),
                                   directory.path());
    QVERIFY(settings.setServiceUrl(QStringLiteral("https://music.example.test/")));
    melodex::CookieStore cookies(directory.filePath(QStringLiteral("cookies.dat")));
    melodex::ApiClient api(&settings, &cookies);

    QCOMPARE(api.coverUrl({
                 {QStringLiteral("id"), QStringLiteral("613053895")},
                 {QStringLiteral("source"), QStringLiteral("qq")},
                 {QStringLiteral("cover"), QStringLiteral(
                      "https://y.gtimg.cn/music/photo_new/T002R300x300M0000.jpg")},
             }),
             QString());
}

void DesktopContractsTest::playerPublishesQueueContractToQml() {
    const QMetaObject &metaObject = melodex::PlayerController::staticMetaObject;

    QVERIFY(metaObject.indexOfProperty("queue") >= 0);
    QVERIFY(metaObject.indexOfProperty("queueIndex") >= 0);
    QVERIFY(metaObject.indexOfSignal("queueChanged()") >= 0);
    QVERIFY(metaObject.indexOfMethod("playQueueIndex(int)") >= 0);
}

void DesktopContractsTest::lyricsSupportWordAndLineTiming() {
    const QVariantList lines = melodex::parseLrc(
        QStringLiteral("[00:00.00]海[00:00.50]棠\n[00:01.00]又落微雨时"));
    QCOMPARE(lines.size(), 2);
    QCOMPARE(lines.constFirst().toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("海棠"));
    QCOMPARE(lines.constFirst().toMap().value(QStringLiteral("words")).toList().size(), 2);
    QCOMPARE(melodex::currentLyricIndex(lines, 1.2), 1);
    QVERIFY(melodex::lyricProgress(lines, 0, 0.75) > 0.5);
}

void DesktopContractsTest::lyricsKeepProductionSameTimestampOrder() {
    const QVariantList lines = melodex::parseLrc(QStringLiteral(
        "[00:44.88]冲[00:45.07]得[00:45.28]破[00:45.66]盲[00:46.03]点"
        "[00:46.77] [00:46.77]找[00:47.40]到[00:47.70]光[00:48.34]点[00:50.78]\n"
        "[00:44.88]cong [00:45.07]da [00:45.28]po [00:45.66]mang "
        "[00:46.03]din [00:46.77] [00:46.77]zou [00:47.40]dou "
        "[00:47.70]guong [00:48.34]din [00:50.78]\n"
        "[00:51.11]TWINS：[00:51.73]\n"
        "[00:52.14]让[00:52.34]二[00:52.62]人[00:52.96]划[00:53.27]破"
        "[00:53.54]黑[00:53.94]夜[00:54.53]\n"));

    QCOMPARE(lines.size(), 4);
    QCOMPARE(lines.at(0).toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("冲得破盲点 找到光点"));
    QCOMPARE(lines.at(1).toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("cong da po mang din  zou dou guong din"));
    QCOMPARE(lines.at(2).toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("TWINS："));
    QCOMPARE(lines.at(3).toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("让二人划破黑夜"));
    const int activeIndex = melodex::currentLyricIndex(lines, 45.0);
    QCOMPARE(activeIndex, 0);
    QCOMPARE(melodex::secondaryLyricIndex(lines, activeIndex), 1);
    QCOMPARE(melodex::currentLyricIndex(lines, 51.2), 2);
    QCOMPARE(melodex::secondaryLyricIndex(lines, 2), 3);
    QVERIFY(qAbs(lines.at(0).toMap().value(QStringLiteral("end")).toDouble() -
                 51.11) < 0.001);
    QVERIFY(qAbs(lines.at(1).toMap().value(QStringLiteral("end")).toDouble() -
                 51.11) < 0.001);

    const QVariantList mixedOrder = melodex::parseLrc(QStringLiteral(
        "[00:01.00]原文在前\n"
        "[00:01.00]translation after\n"
        "[00:03.00]translation before\n"
        "[00:03.00]原文在后\n"));
    const int firstGroup = melodex::currentLyricIndex(mixedOrder, 1.5);
    QCOMPARE(mixedOrder.at(firstGroup).toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("原文在前"));
    QCOMPARE(mixedOrder.at(melodex::secondaryLyricIndex(mixedOrder, firstGroup))
                 .toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("translation after"));
    const int secondGroup = melodex::currentLyricIndex(mixedOrder, 3.5);
    QCOMPARE(mixedOrder.at(secondGroup).toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("translation before"));
    QCOMPARE(mixedOrder.at(melodex::secondaryLyricIndex(mixedOrder, secondGroup))
                 .toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("原文在后"));
}

void DesktopContractsTest::lyricsTypographySupportsPersistedCjkFontPresets() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    melodex::UserSettings settings(QStringLiteral("MelodexTypographyTest"),
                                    directory.path());
#ifdef Q_OS_MACOS
    QCOMPARE(settings.lyricsFontFamily(), QStringLiteral("PingFang SC"));
    const QString selectedPreset = QStringLiteral("华文宋体");
    const QString selectedFamily = QStringLiteral("Songti SC");
#else
    QCOMPARE(settings.lyricsFontFamily(), QStringLiteral("KaiTi"));
    const QString selectedPreset = QStringLiteral("微软雅黑");
    const QString selectedFamily = QStringLiteral("Microsoft YaHei UI");
#endif
    const int selectedIndex = settings.lyricsFontPresetNames().indexOf(selectedPreset);
    QVERIFY(selectedIndex >= 0);
    QVERIFY(settings.setLyricsFontPresetIndex(selectedIndex));
    QCOMPARE(settings.lyricsFontFamily(), selectedFamily);

    melodex::UserSettings restored(QStringLiteral("MelodexTypographyTest"),
                                    directory.path());
    QCOMPARE(restored.lyricsFontPresetIndex(), selectedIndex);
    QCOMPARE(restored.lyricsFontFamily(), selectedFamily);
    QVERIFY(!restored.setLyricsFontPresetIndex(restored.lyricsFontPresetNames().size()));
}

void DesktopContractsTest::playbackStateIsAccountScoped() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    melodex::PlaybackStateStore store(directory.filePath(QStringLiteral("playback.json")));
    const QVariantMap state = {
        {QStringLiteral("position"), 42.5},
        {QStringLiteral("song"), QVariantMap{{QStringLiteral("id"),
                                               QStringLiteral("2140404278")}}},
    };
    QVERIFY(store.save(QStringLiteral("https://music.example.test/"),
                       QStringLiteral("alice"), state));
    QVERIFY(store.load(QStringLiteral("https://music.example.test/"),
                       QStringLiteral("alice")).has_value());
    QVERIFY(!store.load(QStringLiteral("https://music.example.test/"),
                        QStringLiteral("bob")).has_value());
}

void DesktopContractsTest::playbackRestoreWaitsForSeekableStream() {
    constexpr qint64 savedPosition = 80042;
    constexpr qint64 duration = 203000;

    QVERIFY(!melodex::resolvePlaybackRestorePosition(
                 savedPosition, false, duration)
                 .has_value());
    const auto restored = melodex::resolvePlaybackRestorePosition(
        savedPosition, true, duration);
    QVERIFY(restored.has_value());
    QCOMPARE(*restored, savedPosition);
    const auto clamped = melodex::resolvePlaybackRestorePosition(
        duration + 1000, true, duration);
    QVERIFY(clamped.has_value());
    QCOMPARE(*clamped, duration);
}

void DesktopContractsTest::playbackRestoreRemainsVisibleUntilPlayerConfirmsSeek() {
    // 真实退出状态曾记录《凝眸（对唱版）》在 110.762 秒；网络流加载期间
    // QMediaPlayer 仍报告 0，界面必须继续呈现并保留这条待恢复进度。
    constexpr qint64 savedPosition = 110762;

    QCOMPARE(melodex::presentedPlaybackPosition(0, savedPosition),
             savedPosition);
    QVERIFY(!melodex::playbackRestoreReached(0, savedPosition));
    QVERIFY(melodex::playbackRestoreReached(savedPosition, savedPosition));
    QCOMPARE(melodex::presentedPlaybackPosition(savedPosition, std::nullopt),
             savedPosition);
}

void DesktopContractsTest::playbackRestoreDoesNotRestartAnOutstandingSeek() {
    constexpr qint64 savedPosition = 110762;
    constexpr qint64 duration = 192000;

    const auto beforePlayback = melodex::decidePlaybackRestore(
        savedPosition, true, duration, false, false);
    QVERIFY(!beforePlayback.targetMilliseconds.has_value());
    QVERIFY(!beforePlayback.issueSeek);

    const auto initial = melodex::decidePlaybackRestore(
        savedPosition, true, duration, true, false);
    QVERIFY(initial.targetMilliseconds.has_value());
    QCOMPARE(*initial.targetMilliseconds, savedPosition);
    QVERIFY(initial.issueSeek);

    // seekable/mediaStatus/playbackState 可能连续到达；第一次 Range 定位仍在
    // 等待时，点击播放不得再次 setPosition 并取消、重开同一定位请求。
    const auto duplicate = melodex::decidePlaybackRestore(
        savedPosition, true, duration, true, true);
    QVERIFY(duplicate.targetMilliseconds.has_value());
    QCOMPARE(*duplicate.targetMilliseconds, savedPosition);
    QVERIFY(!duplicate.issueSeek);
}

QTEST_GUILESS_MAIN(DesktopContractsTest)

#include "test_contracts.moc"
