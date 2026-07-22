#pragma once

#include <QString>

namespace melodex {

struct WindowConfig {
    int width = 1180;
    int height = 760;
    int minimumWidth = 920;
    int minimumHeight = 620;
};

struct ApplicationConfig {
    QString applicationName;
    QString applicationVersion;
    QString applicationId;
    QString accentColor;
    WindowConfig window;
};

ApplicationConfig loadApplicationConfig(const QString &resourcePath);

}  // namespace melodex
