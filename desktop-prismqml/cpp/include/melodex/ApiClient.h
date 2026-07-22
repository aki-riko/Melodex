#pragma once

#include <QNetworkAccessManager>
#include <QObject>
#include <QVariantList>
#include <QVariantMap>
#include <functional>
#include <memory>

namespace melodex {

class AuthenticatedHttpProxy;
class CookieStore;
class UserSettings;

QUrl resolvePlaybackUrl(const QString &serviceUrl, const QString &rawUrl);

class ApiClient final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool authenticated READ authenticated NOTIFY authenticatedChanged)
    Q_PROPERTY(QVariantMap currentUser READ currentUser NOTIFY currentUserChanged)
    Q_PROPERTY(bool busy READ busy NOTIFY busyChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)
    Q_PROPERTY(QVariantList searchResults READ searchResults NOTIFY searchResultsChanged)

public:
    using RequestCallback =
        std::function<void(const QVariant &payload, const QString &error, int status)>;
    using StreamCallback =
        std::function<void(const QString &streamUrl, const QString &error)>;

    explicit ApiClient(UserSettings *settings, CookieStore *cookies,
                       QObject *parent = nullptr);
    ~ApiClient() override;

    bool authenticated() const { return m_authenticated; }
    QVariantMap currentUser() const { return m_currentUser; }
    bool busy() const { return m_busy; }
    QString error() const { return m_error; }
    QVariantList searchResults() const { return m_searchResults; }

    Q_INVOKABLE void checkSession();
    Q_INVOKABLE void login(const QString &serviceUrl, const QString &username,
                           const QString &password);
    Q_INVOKABLE void logout();
    Q_INVOKABLE void search(const QString &keyword);
    Q_INVOKABLE QString coverUrl(const QVariantMap &song) const;

    void requestJson(const QByteArray &method, const QString &path,
                     RequestCallback callback, const QVariantMap &payload = {});
    void requestStreamUrl(const QVariantMap &song, StreamCallback callback);
    void loadLyrics(const QVariantMap &song);

signals:
    void authenticatedChanged();
    void currentUserChanged();
    void busyChanged();
    void errorChanged();
    void searchResultsChanged();
    void lyricLoaded(const QString &songKey, const QString &rawLyrics);

private:
    void request(const QByteArray &method, const QString &path,
                 RequestCallback callback, const QVariantMap *payload = nullptr,
                 bool expectText = false);
    void finishReply(QNetworkReply *reply, RequestCallback callback, bool expectText);
    QUrl rootUrl(const QString &path) const;
    QByteArray cookieHeaderForUrl(const QUrl &url) const;
    QString responseError(QNetworkReply *reply, const QByteArray &raw,
                          const QByteArray &contentType) const;
    void setAuthenticated(bool authenticated, const QVariantMap &user);
    void setBusy(bool value);
    void setError(const QString &message);

    UserSettings *m_settings = nullptr;
    CookieStore *m_cookies = nullptr;
    std::unique_ptr<AuthenticatedHttpProxy> m_mediaProxy;
    QNetworkAccessManager m_network;
    bool m_authenticated = false;
    QVariantMap m_currentUser;
    bool m_busy = false;
    QString m_error;
    QVariantList m_searchResults;
    quint64 m_sessionSerial = 0;
    quint64 m_searchSerial = 0;
};

}  // namespace melodex
