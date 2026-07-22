#pragma once

#include <QObject>
#include <QPointer>

namespace melodex {

class PlayerController;
class UserSettings;

class DesktopState final : public QObject {
    Q_OBJECT

public:
    explicit DesktopState(UserSettings *settings, PlayerController *player,
                          QObject *parent = nullptr);

    void attachLyricsWindow(QObject *window);
    Q_INVOKABLE void toggleClickThrough();
    Q_INVOKABLE void toggleLyricsVisible();

private:
    void queueLyricsWindowSync();
    void syncLyricsWindow();

    UserSettings *m_settings = nullptr;
    PlayerController *m_player = nullptr;
    QPointer<QObject> m_lyricsWindow;
};

}  // namespace melodex
