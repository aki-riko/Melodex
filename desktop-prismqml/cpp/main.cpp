// SPDX-License-Identifier: AGPL-3.0-only
#include "melodex/ApiClient.h"
#include "melodex/ApplicationConfig.h"
#include "melodex/CollectionController.h"
#include "melodex/CookieStore.h"
#include "melodex/DesktopState.h"
#include "melodex/PlayerController.h"
#include "melodex/UserSettings.h"

#include "prism/App.h"
#include "prism/SystemTray.h"
#include "prism/Theme.h"

#include <QApplication>
#include <QCoreApplication>
#include <QDebug>
#include <QDir>
#include <QFileInfo>
#include <QGuiApplication>
#include <QIcon>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QTimer>
#include <QUrl>
#include <QVariantMap>
#include <QWindow>
#include <memory>
#include <stdexcept>

#ifdef Q_OS_WIN
#include <shobjidl_core.h>
#endif

namespace {

constexpr auto kConfigUrl = ":/Melodex/app_config.json";
constexpr auto kIconPath = ":/Melodex/assets/logo512.png";
constexpr auto kIconUrl = "qrc:/Melodex/assets/logo512.png";
constexpr auto kMainQmlUrl = "qrc:/Melodex/qml/main.qml";

QString prismQmlImportPath(const char *executableArgument) {
    const QString configured =
        qEnvironmentVariable("PRISMQML_QML_DIR").trimmed();
    if (!configured.isEmpty())
        return QDir::cleanPath(configured);

    const QFileInfo executable(QString::fromLocal8Bit(executableArgument));
    const QDir executableDirectory(executable.absolutePath());
    const QString bundled = executableDirectory.filePath(QStringLiteral("qml"));
    if (QFileInfo::exists(QDir(bundled).filePath(QStringLiteral("PrismQML/qmldir"))))
        return QDir::cleanPath(bundled);

    return QStringLiteral(PRISM_QML_DIR);
}

struct Services {
    melodex::UserSettings *settings = nullptr;
    melodex::CookieStore *cookies = nullptr;
    melodex::ApiClient *api = nullptr;
    melodex::CollectionController *collections = nullptr;
    melodex::PlayerController *player = nullptr;
    melodex::DesktopState *desktopState = nullptr;
};

void configureQtLogging() {
    QList<QByteArray> rules = qgetenv("QT_LOGGING_RULES").split(';');
    const QList<QByteArray> required = {
        "qt.text.font.db=false",
        "qt.multimedia.ffmpeg=false",
        "qt.multimedia.ffmpeg.*=false",
    };
    for (const QByteArray &rule : required) {
        if (!rules.contains(rule))
            rules.append(rule);
    }
    rules.removeAll({});
    qputenv("QT_LOGGING_RULES", rules.join(';'));
}

void applyApplicationIdentity(const QString &applicationId) {
    qputenv("PRISMQML_APP_USER_MODEL_ID", applicationId.toUtf8());
#ifdef Q_OS_WIN
    const HRESULT result = SetCurrentProcessExplicitAppUserModelID(
        reinterpret_cast<PCWSTR>(applicationId.utf16()));
    if (FAILED(result))
        qWarning() << "[WARN] 无法设置 Windows 应用身份：" << Qt::hex << result;
#endif
}

QVariantMap configForQml(const melodex::ApplicationConfig &config) {
    return {
        {QStringLiteral("name"), config.applicationName},
        {QStringLiteral("version"), config.applicationVersion},
        {QStringLiteral("windowWidth"), config.window.width},
        {QStringLiteral("windowHeight"), config.window.height},
        {QStringLiteral("minimumWindowWidth"), config.window.minimumWidth},
        {QStringLiteral("minimumWindowHeight"), config.window.minimumHeight},
        {QStringLiteral("iconUrl"), QString::fromLatin1(kIconUrl)},
    };
}

Services createServices(const melodex::ApplicationConfig &config,
                        QApplication *application) {
    Services services;
    services.settings = new melodex::UserSettings(config.applicationName, {}, application);
    services.cookies = new melodex::CookieStore(
        services.settings->storagePath(QStringLiteral("cookies.dat")), application);
    services.api = new melodex::ApiClient(services.settings, services.cookies, application);
    services.collections = new melodex::CollectionController(services.api, application);
    services.player = new melodex::PlayerController(
        services.api, services.settings, application);
    services.desktopState = new melodex::DesktopState(
        services.settings, services.player, application);
    return services;
}

void publishContext(QQmlApplicationEngine *engine,
                    const melodex::ApplicationConfig &config,
                    const Services &services, bool selfTest) {
    QQmlContext *context = engine->rootContext();
    context->setContextProperty(QStringLiteral("AppConfig"), configForQml(config));
    context->setContextProperty(QStringLiteral("UserSettings"), services.settings);
    context->setContextProperty(QStringLiteral("Api"), services.api);
    context->setContextProperty(QStringLiteral("Collections"), services.collections);
    context->setContextProperty(QStringLiteral("Player"), services.player);
    context->setContextProperty(QStringLiteral("DesktopState"), services.desktopState);
    context->setContextProperty(QStringLiteral("HeadlessSelfTest"), selfTest);
}

QObject *requiredChild(QObject *root, const QString &objectName) {
    QObject *child = root ? root->findChild<QObject *>(objectName) : nullptr;
    if (!child)
        qCritical().noquote() << "[ERROR] 未找到 QML 对象：" << objectName;
    return child;
}

void restoreMainWindow(QObject *mainWindow) {
    auto *window = qobject_cast<QWindow *>(mainWindow);
    if (!window)
        return;
    window->showNormal();
    QMetaObject::invokeMethod(mainWindow, "restoreVisibleState");
    window->raise();
    window->requestActivate();
}

prism::SystemTrayIcon *installTray(const melodex::ApplicationConfig &config,
                                   QObject *mainWindow,
                                   melodex::UserSettings *settings,
                                   QApplication *application) {
    auto *tray = new prism::SystemTrayIcon(
        QString::fromLatin1(kIconPath), config.applicationName, application);
    prism::TrayActionOptions showOptions;
    showOptions.actionId = QStringLiteral("show");
    tray->addAction(QStringLiteral("显示 %1").arg(config.applicationName),
                    [mainWindow]() { restoreMainWindow(mainWindow); }, showOptions);

    prism::TrayActionOptions lyricsOptions;
    lyricsOptions.actionId = QStringLiteral("lyrics-visible");
    lyricsOptions.checkable = true;
    lyricsOptions.checked = settings->lyricsVisible();
    tray->addAction(QStringLiteral("显示桌面歌词"),
                    [settings]() { settings->toggleLyricsVisible(); }, lyricsOptions);

    prism::TrayActionOptions lockOptions;
    lockOptions.actionId = QStringLiteral("click-through");
    lockOptions.checkable = true;
    lockOptions.checked = settings->clickThrough();
    tray->addAction(QStringLiteral("锁定桌面歌词"),
                    [settings]() { settings->toggleClickThrough(); }, lockOptions);
    tray->addSeparator();

    prism::TrayActionOptions quitOptions;
    quitOptions.actionId = QStringLiteral("quit");
    tray->addAction(QStringLiteral("退出"), []() { QCoreApplication::quit(); },
                    quitOptions);
    QObject::connect(settings, &melodex::UserSettings::clickThroughChanged, tray,
                     [tray, settings]() {
                         tray->setActionChecked(QStringLiteral("click-through"),
                                                settings->clickThrough());
                     });
    QObject::connect(settings, &melodex::UserSettings::lyricsVisibleChanged, tray,
                     [tray, settings]() {
                         tray->setActionChecked(QStringLiteral("lyrics-visible"),
                                                settings->lyricsVisible());
                     });
    tray->show();
    return tray;
}

int runApplication(int argc, char *argv[]) {
    configureQtLogging();
    const melodex::ApplicationConfig config =
        melodex::loadApplicationConfig(QString::fromLatin1(kConfigUrl));
    applyApplicationIdentity(config.applicationId);
    const bool selfTest = qEnvironmentVariableIntValue("MELODEX_DESKTOP_SELFTEST") == 1;

    std::unique_ptr<melodex::SharedNetworkAccessManagerFactory> networkFactory;
    prism::App app(argc, argv, prismQmlImportPath(argv[0]));
    app.qapp()->setApplicationName(config.applicationName);
    app.qapp()->setApplicationVersion(config.applicationVersion);
    app.qapp()->setQuitOnLastWindowClosed(false);
    prism::setTheme(prism::Theme::Light);
    prism::setSkin(prism::Skin::Fluent);
    prism::setAccentColor(config.accentColor);

    const QIcon icon(QString::fromLatin1(kIconPath));
    if (!icon.isNull())
        QGuiApplication::setWindowIcon(icon);
    const Services services = createServices(config, app.qapp());
    networkFactory = std::make_unique<melodex::SharedNetworkAccessManagerFactory>(
        services.cookies);
    app.engine()->setNetworkAccessManagerFactory(networkFactory.get());
    publishContext(app.engine(), config, services, selfTest);
    app.engine()->load(QUrl(QString::fromLatin1(kMainQmlUrl)));
    if (app.engine()->rootObjects().isEmpty())
        throw std::runtime_error("Melodex PrismQML 主界面加载失败");

    QObject *qmlRoot = app.engine()->rootObjects().constFirst();
    QObject *mainWindow = requiredChild(qmlRoot, QStringLiteral("mainWindow"));
    QObject *lyricsWindow = requiredChild(qmlRoot, QStringLiteral("desktopLyricsWindow"));
    if (!mainWindow || !lyricsWindow)
        return -1;
    services.desktopState->attachLyricsWindow(lyricsWindow);
    QObject::connect(app.qapp(), &QCoreApplication::aboutToQuit,
                     services.player, &melodex::PlayerController::flushPlaybackState);

    if (selfTest) {
        qInfo() << "MELODEX_DESKTOP_SELFTEST_OK";
        QTimer::singleShot(500, app.qapp(), &QCoreApplication::quit);
    } else {
        if (auto *window = qobject_cast<QWindow *>(mainWindow))
            window->show();
        installTray(config, mainWindow, services.settings, app.qapp());
        QTimer::singleShot(0, services.api, &melodex::ApiClient::checkSession);
    }
    return app.exec();
}

}  // namespace

int main(int argc, char *argv[]) {
    try {
        return runApplication(argc, argv);
    } catch (const std::exception &error) {
        qCritical().noquote() << "[ERROR]" << error.what();
        return -1;
    }
}
