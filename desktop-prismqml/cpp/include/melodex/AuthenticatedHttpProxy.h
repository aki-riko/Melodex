#pragma once

#include <QByteArray>
#include <QObject>
#include <QThread>
#include <QUrl>

namespace melodex {

class AuthenticatedHttpProxyWorker;

class AuthenticatedHttpProxy final : public QObject {
public:
    explicit AuthenticatedHttpProxy(QObject *parent = nullptr);
    ~AuthenticatedHttpProxy() override;

    QUrl registerUrl(const QUrl &remoteUrl,
                     const QByteArray &cookieHeader = {}) const;
    void clear();

    bool isListening() const { return m_listening; }
    QString errorString() const { return m_startError; }

private:
    QThread m_thread;
    AuthenticatedHttpProxyWorker *m_worker = nullptr;
    bool m_listening = false;
    QString m_startError;
};

}  // namespace melodex
