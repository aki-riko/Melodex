#pragma once

#include <QNetworkCookie>
#include <QNetworkCookieJar>
#include <QQmlNetworkAccessManagerFactory>

class QNetworkAccessManager;

namespace melodex {

class CookieStore final : public QObject {
    Q_OBJECT

public:
    explicit CookieStore(const QString &path, QObject *parent = nullptr);

    QList<QNetworkCookie> cookiesForUrl(const QUrl &url) const;
    bool setCookiesFromUrl(const QList<QNetworkCookie> &cookies, const QUrl &url);
    void clear();
    void save() const;

private:
    class MatcherJar;
    void load();

    QString m_path;
    MatcherJar *m_matcher = nullptr;
};

class DelegatingCookieJar final : public QNetworkCookieJar {
    Q_OBJECT

public:
    explicit DelegatingCookieJar(CookieStore *store, QObject *parent = nullptr);
    QList<QNetworkCookie> cookiesForUrl(const QUrl &url) const override;
    bool setCookiesFromUrl(const QList<QNetworkCookie> &cookies,
                           const QUrl &url) override;

private:
    CookieStore *m_store = nullptr;
};

class SharedNetworkAccessManagerFactory final
    : public QQmlNetworkAccessManagerFactory {
public:
    explicit SharedNetworkAccessManagerFactory(CookieStore *store);
    QNetworkAccessManager *create(QObject *parent) override;

private:
    CookieStore *m_store = nullptr;
};

}  // namespace melodex
