#include "melodex/DesktopState.h"

#include "melodex/PlayerController.h"
#include "melodex/UserSettings.h"

#include <QTimer>
#include <QWindow>

namespace melodex {

DesktopState::DesktopState(UserSettings *settings, PlayerController *player,
                           QObject *parent)
    : QObject(parent), m_settings(settings), m_player(player) {
    connect(m_settings, &UserSettings::lyricsVisibleChanged, this,
            &DesktopState::queueLyricsWindowSync);
    connect(m_settings, &UserSettings::clickThroughChanged, this,
            &DesktopState::queueLyricsWindowSync);
    connect(m_player, &PlayerController::currentSongChanged, this,
            &DesktopState::queueLyricsWindowSync);
}

void DesktopState::attachLyricsWindow(QObject *window) {
    m_lyricsWindow = window;
    syncLyricsWindow();
}

void DesktopState::queueLyricsWindowSync() {
    QTimer::singleShot(0, this, &DesktopState::syncLyricsWindow);
}

void DesktopState::syncLyricsWindow() {
    if (!m_lyricsWindow)
        return;
    const bool hasSong = !m_player->currentSong().value(QStringLiteral("id"))
                              .toString().isEmpty();
    const bool show = m_settings->lyricsVisible() && hasSong;
    if (auto *window = qobject_cast<QWindow *>(m_lyricsWindow.data()))
        window->setVisible(show);
    else
        QMetaObject::invokeMethod(m_lyricsWindow.data(), show ? "show" : "hide");
}

void DesktopState::toggleClickThrough() { m_settings->toggleClickThrough(); }

void DesktopState::toggleLyricsVisible() { m_settings->toggleLyricsVisible(); }

}  // namespace melodex
