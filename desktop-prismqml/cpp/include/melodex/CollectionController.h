#pragma once

#include <QObject>
#include <QSet>
#include <QVariantList>
#include <QVariantMap>

namespace melodex {

class ApiClient;

class CollectionController final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantList collections READ collections NOTIFY collectionsChanged)
    Q_PROPERTY(QVariantMap selectedCollection READ selectedCollection
                   NOTIFY selectedCollectionChanged)
    Q_PROPERTY(int selectedIndex READ selectedIndex NOTIFY selectedIndexChanged)
    Q_PROPERTY(QVariantList songs READ songs NOTIFY songsChanged)
    Q_PROPERTY(QStringList writableCollectionNames READ writableCollectionNames
                   NOTIFY writableCollectionsChanged)
    Q_PROPERTY(int targetIndex READ targetIndex NOTIFY targetIndexChanged)
    Q_PROPERTY(bool busy READ busy NOTIFY busyChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)
    Q_PROPERTY(QString notice READ notice NOTIFY noticeChanged)

public:
    explicit CollectionController(ApiClient *api, QObject *parent = nullptr);

    QVariantList collections() const;
    QVariantMap selectedCollection() const { return m_selectedCollection; }
    int selectedIndex() const;
    QVariantList songs() const;
    QStringList writableCollectionNames() const;
    int targetIndex() const;
    bool busy() const { return !m_activeRequests.isEmpty(); }
    QString error() const { return m_error; }
    QString notice() const { return m_notice; }

    Q_INVOKABLE void refresh();
    Q_INVOKABLE void selectCollectionIndex(int index);
    Q_INVOKABLE void refreshSongs();
    Q_INVOKABLE void createCollection(const QString &name);
    Q_INVOKABLE void setTargetCollectionIndex(int index);
    Q_INVOKABLE void addSong(const QVariantMap &song);
    Q_INVOKABLE void clearMessages();

signals:
    void collectionsChanged();
    void selectedCollectionChanged();
    void selectedIndexChanged();
    void songsChanged();
    void writableCollectionsChanged();
    void targetIndexChanged();
    void busyChanged();
    void errorChanged();
    void noticeChanged();
    void collectionCreated(const QString &collectionId);

private slots:
    void onAuthenticationChanged();

private:
    QString beginRequest(const QString &scope, bool replace = true);
    void endRequest(const QString &token);
    void clearState();
    void setError(const QString &message);
    void setNotice(const QString &message);
    int collectionIndex(const QString &collectionId) const;
    QList<QVariantMap> writableCollections() const;
    void syncTargetCollection(int previousIndex);
    void selectIndex(int index);
    void loadSelectedSongs();
    void downloadAddedSong(const QVariantMap &song);

    ApiClient *m_api = nullptr;
    QList<QVariantMap> m_collections;
    QVariantMap m_selectedCollection;
    QList<QVariantMap> m_songs;
    QString m_targetId;
    QString m_preferredCollectionId;
    QSet<QString> m_activeRequests;
    quint64 m_requestTokenSerial = 0;
    quint64 m_sessionGeneration = 0;
    quint64 m_listSerial = 0;
    quint64 m_songsSerial = 0;
    QString m_error;
    QString m_notice;
};

}  // namespace melodex
