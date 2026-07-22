#include "melodex/CollectionController.h"

#include "melodex/ApiClient.h"
#include "melodex/JsonUtils.h"

#include <QUrl>
#include <algorithm>

namespace melodex {
namespace {

QString encodedPathId(const QString &value) {
    return QString::fromLatin1(QUrl::toPercentEncoding(value));
}

}  // namespace

CollectionController::CollectionController(ApiClient *api, QObject *parent)
    : QObject(parent), m_api(api) {
    connect(m_api, &ApiClient::authenticatedChanged, this,
            &CollectionController::onAuthenticationChanged);
    if (m_api->authenticated())
        refresh();
}

QVariantList CollectionController::collections() const {
    return toVariantList(m_collections);
}

QVariantList CollectionController::songs() const { return toVariantList(m_songs); }

int CollectionController::selectedIndex() const {
    return collectionIndex(m_selectedCollection.value(QStringLiteral("id")).toString());
}

QStringList CollectionController::writableCollectionNames() const {
    QStringList names;
    for (const QVariantMap &collection : writableCollections())
        names.append(collection.value(QStringLiteral("name")).toString());
    return names;
}

int CollectionController::targetIndex() const {
    const QList<QVariantMap> writable = writableCollections();
    for (int index = 0; index < writable.size(); ++index) {
        if (writable.at(index).value(QStringLiteral("id")).toString() == m_targetId)
            return index;
    }
    return -1;
}

QString CollectionController::beginRequest(const QString &scope, bool replace) {
    const bool wasBusy = busy();
    if (replace) {
        const QString prefix = scope + QLatin1Char(':');
        for (auto it = m_activeRequests.begin(); it != m_activeRequests.end();) {
            if (it->startsWith(prefix))
                it = m_activeRequests.erase(it);
            else
                ++it;
        }
    }
    const QString token = scope + QLatin1Char(':') +
                          QString::number(++m_requestTokenSerial);
    m_activeRequests.insert(token);
    if (!wasBusy)
        emit busyChanged();
    return token;
}

void CollectionController::endRequest(const QString &token) {
    const bool wasBusy = busy();
    m_activeRequests.remove(token);
    if (wasBusy && !busy())
        emit busyChanged();
}

void CollectionController::setError(const QString &message) {
    if (message == m_error)
        return;
    m_error = message;
    emit errorChanged();
}

void CollectionController::setNotice(const QString &message) {
    if (message == m_notice)
        return;
    m_notice = message;
    emit noticeChanged();
}

void CollectionController::clearState() {
    m_collections.clear();
    m_selectedCollection.clear();
    m_songs.clear();
    m_targetId.clear();
    m_preferredCollectionId.clear();
    m_activeRequests.clear();
    m_error.clear();
    m_notice.clear();
    emit collectionsChanged();
    emit selectedCollectionChanged();
    emit selectedIndexChanged();
    emit songsChanged();
    emit writableCollectionsChanged();
    emit targetIndexChanged();
    emit busyChanged();
    emit errorChanged();
    emit noticeChanged();
}

void CollectionController::onAuthenticationChanged() {
    ++m_sessionGeneration;
    ++m_listSerial;
    ++m_songsSerial;
    clearState();
    if (m_api->authenticated())
        refresh();
}

void CollectionController::refresh() {
    if (!m_api->authenticated())
        return;
    const quint64 serial = ++m_listSerial;
    const quint64 generation = m_sessionGeneration;
    const QString previousId = !m_preferredCollectionId.isEmpty()
                                   ? m_preferredCollectionId
                                   : m_selectedCollection.value(QStringLiteral("id"))
                                         .toString();
    m_preferredCollectionId.clear();
    setError({});
    const QString token = beginRequest(QStringLiteral("collections"));
    m_api->requestJson(
        "GET", QStringLiteral("/music/collections?include_imported=1"),
        [this, token, generation, serial, previousId](const QVariant &payload,
                                                      const QString &error, int) {
            endRequest(token);
            if (generation != m_sessionGeneration || serial != m_listSerial)
                return;
            if (!error.isEmpty()) {
                setError(error);
                return;
            }
            const int previousTargetIndex = targetIndex();
            m_collections.clear();
            for (const QVariantMap &value : variantMaps(payload))
                m_collections.append(normalizeCollection(value));
            emit collectionsChanged();
            emit writableCollectionsChanged();
            syncTargetCollection(previousTargetIndex);
            int index = collectionIndex(previousId);
            if (index < 0 && !m_collections.isEmpty()) {
                index = 0;
                for (int candidate = 0; candidate < m_collections.size(); ++candidate) {
                    if (m_collections.at(candidate).value(QStringLiteral("kind")).toString() ==
                        QStringLiteral("favorite")) {
                        index = candidate;
                        break;
                    }
                }
            }
            selectIndex(index);
            emit selectedIndexChanged();
        });
}

int CollectionController::collectionIndex(const QString &collectionId) const {
    for (int index = 0; index < m_collections.size(); ++index) {
        if (m_collections.at(index).value(QStringLiteral("id")).toString() == collectionId)
            return index;
    }
    return -1;
}

QList<QVariantMap> CollectionController::writableCollections() const {
    QList<QVariantMap> writable;
    std::copy_if(m_collections.cbegin(), m_collections.cend(),
                 std::back_inserter(writable), [](const QVariantMap &item) {
                     return item.value(QStringLiteral("kind")).toString() !=
                            QStringLiteral("imported");
                 });
    return writable;
}

void CollectionController::syncTargetCollection(int previousIndex) {
    const QList<QVariantMap> writable = writableCollections();
    const bool targetExists = std::any_of(
        writable.cbegin(), writable.cend(), [this](const QVariantMap &item) {
            return item.value(QStringLiteral("id")).toString() == m_targetId;
        });
    if (!targetExists) {
        QVariantMap nextTarget;
        for (const QVariantMap &item : writable) {
            if (item.value(QStringLiteral("kind")).toString() == QStringLiteral("favorite")) {
                nextTarget = item;
                break;
            }
        }
        if (nextTarget.isEmpty() && !writable.isEmpty())
            nextTarget = writable.front();
        m_targetId = nextTarget.value(QStringLiteral("id")).toString();
    }
    if (previousIndex != targetIndex())
        emit targetIndexChanged();
}

void CollectionController::selectCollectionIndex(int index) { selectIndex(index); }

void CollectionController::selectIndex(int index) {
    const QVariantMap next = index >= 0 && index < m_collections.size()
                                 ? m_collections.at(index)
                                 : QVariantMap{};
    if (next != m_selectedCollection) {
        m_selectedCollection = next;
        emit selectedCollectionChanged();
        emit selectedIndexChanged();
    }
    loadSelectedSongs();
}

void CollectionController::refreshSongs() { loadSelectedSongs(); }

void CollectionController::loadSelectedSongs() {
    const quint64 serial = ++m_songsSerial;
    const quint64 generation = m_sessionGeneration;
    const QString collectionId = m_selectedCollection.value(QStringLiteral("id")).toString();
    m_songs.clear();
    emit songsChanged();
    if (collectionId.isEmpty())
        return;
    setError({});
    const QString token = beginRequest(QStringLiteral("songs"));
    const QString path = QStringLiteral("/music/collections/") + encodedPathId(collectionId) +
                         QStringLiteral("/songs");
    m_api->requestJson("GET", path,
                       [this, token, generation, serial, collectionId](
                           const QVariant &payload, const QString &error, int) {
                           endRequest(token);
                           if (generation != m_sessionGeneration || serial != m_songsSerial ||
                               collectionId != m_selectedCollection
                                                   .value(QStringLiteral("id")).toString())
                               return;
                           if (!error.isEmpty()) {
                               setError(error);
                               return;
                           }
                           QVariant values = payload;
                           if (payload.canConvert<QVariantMap>())
                               values = payload.toMap().value(QStringLiteral("songs"));
                           m_songs.clear();
                           for (const QVariantMap &song : variantMaps(values))
                               m_songs.append(normalizeSong(song));
                           emit songsChanged();
                       });
}

void CollectionController::createCollection(const QString &rawName) {
    const QString name = rawName.trimmed();
    if (name.isEmpty()) {
        setError(QStringLiteral("请输入歌单名称"));
        return;
    }
    const quint64 generation = m_sessionGeneration;
    setError({});
    setNotice({});
    const QString token = beginRequest(QStringLiteral("create"), false);
    m_api->requestJson(
        "POST", QStringLiteral("/music/collections"),
        [this, token, generation, name](const QVariant &payload,
                                        const QString &error, int) {
            endRequest(token);
            if (generation != m_sessionGeneration)
                return;
            if (!error.isEmpty()) {
                setError(error);
                return;
            }
            m_preferredCollectionId = payload.toMap().value(QStringLiteral("id")).toString();
            setNotice(QStringLiteral("已创建歌单「%1」").arg(name));
            emit collectionCreated(m_preferredCollectionId);
            refresh();
        },
        {{QStringLiteral("name"), name}});
}

void CollectionController::setTargetCollectionIndex(int index) {
    const QList<QVariantMap> writable = writableCollections();
    if (index < 0 || index >= writable.size())
        return;
    const QString nextId = writable.at(index).value(QStringLiteral("id")).toString();
    if (nextId == m_targetId)
        return;
    m_targetId = nextId;
    emit targetIndexChanged();
}

void CollectionController::addSong(const QVariantMap &song) {
    QVariantMap target;
    for (const QVariantMap &item : writableCollections()) {
        if (item.value(QStringLiteral("id")).toString() == m_targetId) {
            target = item;
            break;
        }
    }
    if (target.isEmpty()) {
        setError(QStringLiteral("请先创建或选择一个可写歌单"));
        return;
    }
    const QVariantMap payload = songWritePayload(song);
    if (payload.value(QStringLiteral("id")).toString().isEmpty() ||
        payload.value(QStringLiteral("source")).toString().isEmpty()) {
        setError(QStringLiteral("歌曲缺少来源标识，无法加入歌单"));
        return;
    }
    const quint64 generation = m_sessionGeneration;
    const QString targetId = target.value(QStringLiteral("id")).toString();
    const QString targetName = target.value(QStringLiteral("name")).toString();
    setError({});
    setNotice({});
    const QString token = beginRequest(QStringLiteral("add"), false);
    const QString path = QStringLiteral("/music/collections/") + encodedPathId(targetId) +
                         QStringLiteral("/songs");
    m_api->requestJson(
        "POST", path,
        [this, token, generation, targetId, targetName, song](
            const QVariant &, const QString &error, int) {
            endRequest(token);
            if (generation != m_sessionGeneration)
                return;
            if (!error.isEmpty()) {
                setError(error);
                return;
            }
            setNotice(QStringLiteral("已加入「%1」").arg(targetName));
            downloadAddedSong(song);
            if (targetId == m_selectedCollection.value(QStringLiteral("id")).toString())
                loadSelectedSongs();
        },
        payload);
}

void CollectionController::downloadAddedSong(const QVariantMap &song) {
    const QString query = encodedQuery(songQuery(
        song, {{QStringLiteral("embed"), QStringLiteral("1")},
               {QStringLiteral("save_local"), QStringLiteral("1")}}));
    m_api->requestJson(
        "POST", QStringLiteral("/music/download?") + query,
        [](const QVariant &, const QString &error, int) {
            if (!error.isEmpty())
                qWarning().noquote()
                    << "[WARN] 歌曲已加入歌单，但后台下载到服务器失败：" << error;
        });
}

void CollectionController::clearMessages() {
    setError({});
    setNotice({});
}

}  // namespace melodex
