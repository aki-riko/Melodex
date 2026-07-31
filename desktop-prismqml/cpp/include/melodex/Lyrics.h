#pragma once

#include <QString>
#include <QVariantList>

namespace melodex {

QVariantList parseLrc(const QString &raw);
int currentLyricIndex(const QVariantList &lines, double positionSeconds);
int secondaryLyricIndex(const QVariantList &lines, int activeIndex);
double lyricProgress(const QVariantList &lines, int index, double positionSeconds);

}  // namespace melodex
