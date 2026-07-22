#include "melodex/CookieStore.h"

#include <QDir>
#include <QFile>
#include <QNetworkAccessManager>
#include <QSaveFile>

namespace melodex {

class CookieStore::MatcherJar final : public QNetworkCookieJar {
public:
    explicit MatcherJar(QObject *parent = nullptr) : QNetworkCookieJar(parent) {}
    QList<QNetworkCookie> all() const { return allCookies(); }
    void replace(const QList<QNetworkCookie> &cookies) { setAllCookies(cookies); }
};

CookieStore::CookieStore(const QString &path, QObject *parent)
    : QObject(parent), m_path(path), m_matcher(new MatcherJar(this)) {
    load();
}

void CookieStore::load() {
    QFile file(m_path);
    if (!file.exists() || !file.open(QIODevice::ReadOnly | QIODevice::Text))
        return;
    QList<QNetworkCookie> cookies;
    while (!file.atEnd()) {
        const QByteArray encoded = file.readLine().trimmed();
        if (encoded.isEmpty())
            continue;
        const QByteArray raw = QByteArray::fromBase64(
            encoded, QByteArray::AbortOnBase64DecodingErrors);
        if (raw.isNull()) {
            qWarning() << "[WARN] 忽略损坏的桌面会话记录";
            continue;
        }
        cookies.append(QNetworkCookie::parseCookies(raw));
    }
    m_matcher->replace(cookies);
}

QList<QNetworkCookie> CookieStore::cookiesForUrl(const QUrl &url) const {
    return m_matcher->cookiesForUrl(url);
}

bool CookieStore::setCookiesFromUrl(const QList<QNetworkCookie> &cookies,
                                    const QUrl &url) {
    const bool changed = m_matcher->setCookiesFromUrl(cookies, url);
    if (changed)
        save();
    return changed;
}

void CookieStore::clear() {
    m_matcher->replace({});
    save();
}

void CookieStore::save() const {
    const QFileInfo info(m_path);
    if (!QDir().mkpath(info.absolutePath())) {
        qWarning().noquote() << "[WARN] 无法创建桌面会话目录：" << info.absolutePath();
        return;
    }
    QByteArray body;
    for (const QNetworkCookie &cookie : m_matcher->all()) {
        body.append(cookie.toRawForm(QNetworkCookie::Full).toBase64());
        body.append('\n');
    }
    QSaveFile file(m_path);
    file.setDirectWriteFallback(false);
    if (!file.open(QIODevice::WriteOnly) || file.write(body) != body.size() ||
        !file.commit()) {
        qWarning().noquote() << "[WARN] 保存桌面会话失败：" << file.errorString();
    }
#ifndef Q_OS_WIN
    QFile::setPermissions(m_path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
#endif
}

DelegatingCookieJar::DelegatingCookieJar(CookieStore *store, QObject *parent)
    : QNetworkCookieJar(parent), m_store(store) {}

QList<QNetworkCookie> DelegatingCookieJar::cookiesForUrl(const QUrl &url) const {
    return m_store ? m_store->cookiesForUrl(url) : QList<QNetworkCookie>{};
}

bool DelegatingCookieJar::setCookiesFromUrl(const QList<QNetworkCookie> &cookies,
                                            const QUrl &url) {
    return m_store && m_store->setCookiesFromUrl(cookies, url);
}

SharedNetworkAccessManagerFactory::SharedNetworkAccessManagerFactory(
    CookieStore *store)
    : m_store(store) {}

QNetworkAccessManager *SharedNetworkAccessManagerFactory::create(QObject *parent) {
    auto *manager = new QNetworkAccessManager(parent);
    manager->setCookieJar(new DelegatingCookieJar(m_store, manager));
    return manager;
}

}  // namespace melodex
