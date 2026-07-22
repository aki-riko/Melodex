#include "melodex/Lyrics.h"

#include <QRegularExpression>
#include <algorithm>

namespace melodex {
namespace {

const QRegularExpression &timestampExpression() {
    static const QRegularExpression expression(
        QStringLiteral(R"(\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\])"));
    return expression;
}

double seconds(const QRegularExpressionMatch &match) {
    QString fraction = match.captured(3);
    while (fraction.size() < 3)
        fraction.append(QLatin1Char('0'));
    const int milliseconds = fraction.isEmpty() ? 0 : fraction.toInt();
    return match.captured(1).toInt() * 60 + match.captured(2).toInt() +
           milliseconds / 1000.0;
}

}  // namespace

QVariantList parseLrc(const QString &raw) {
    QVariantList output;
    for (const QString &line : raw.split(QLatin1Char('\n'))) {
        QList<QRegularExpressionMatch> matches;
        auto iterator = timestampExpression().globalMatch(line);
        while (iterator.hasNext())
            matches.append(iterator.next());
        if (matches.isEmpty())
            continue;

        QVariantList segments;
        QString text;
        for (int index = 0; index < matches.size(); ++index) {
            const int start = matches.at(index).capturedEnd();
            const int end = index + 1 < matches.size()
                                ? matches.at(index + 1).capturedStart()
                                : line.size();
            const QString segmentText = line.mid(start, end - start);
            text.append(segmentText);
            segments.append(QVariantMap{{QStringLiteral("t"), seconds(matches.at(index))},
                                        {QStringLiteral("s"), segmentText}});
        }
        while (!text.isEmpty() && text.back().isSpace())
            text.chop(1);
        if (text.trimmed().isEmpty())
            continue;
        QVariantList words;
        for (const QVariant &segment : segments) {
            if (!segment.toMap().value(QStringLiteral("s")).toString().isEmpty())
                words.append(segment);
        }
        if (words.size() < 2)
            words.clear();
        output.append(QVariantMap{{QStringLiteral("t"),
                                   segments.front().toMap().value(QStringLiteral("t"))},
                                  {QStringLiteral("text"), text},
                                  {QStringLiteral("words"), words}});
    }
    std::sort(output.begin(), output.end(), [](const QVariant &left, const QVariant &right) {
        return left.toMap().value(QStringLiteral("t")).toDouble() <
               right.toMap().value(QStringLiteral("t")).toDouble();
    });
    for (int lineIndex = 0; lineIndex < output.size(); ++lineIndex) {
        QVariantMap line = output.at(lineIndex).toMap();
        const double lineEnd = lineIndex + 1 < output.size()
                                   ? output.at(lineIndex + 1).toMap()
                                         .value(QStringLiteral("t")).toDouble()
                                   : line.value(QStringLiteral("t")).toDouble() + 5.0;
        line.insert(QStringLiteral("end"), lineEnd);
        QVariantList words = line.value(QStringLiteral("words")).toList();
        for (int wordIndex = 0; wordIndex < words.size(); ++wordIndex) {
            QVariantMap word = words.at(wordIndex).toMap();
            const double wordEnd = wordIndex + 1 < words.size()
                                       ? words.at(wordIndex + 1).toMap()
                                             .value(QStringLiteral("t")).toDouble()
                                       : lineEnd;
            word.insert(QStringLiteral("end"), wordEnd);
            words[wordIndex] = word;
        }
        line.insert(QStringLiteral("words"), words);
        output[lineIndex] = line;
    }
    return output;
}

int currentLyricIndex(const QVariantList &lines, double positionSeconds) {
    int low = 0;
    int high = lines.size() - 1;
    int answer = -1;
    while (low <= high) {
        const int middle = (low + high) / 2;
        const double timestamp = lines.at(middle).toMap()
                                     .value(QStringLiteral("t")).toDouble();
        if (timestamp <= positionSeconds) {
            answer = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return answer;
}

double lyricProgress(const QVariantList &lines, int index, double positionSeconds) {
    if (index < 0 || index >= lines.size())
        return 0.0;
    const QVariantMap line = lines.at(index).toMap();
    const QVariantList words = line.value(QStringLiteral("words")).toList();
    if (!words.isEmpty()) {
        int totalChars = 0;
        double completedChars = 0.0;
        for (const QVariant &entry : words)
            totalChars += qMax(1, entry.toMap().value(QStringLiteral("s")).toString().size());
        for (const QVariant &entry : words) {
            const QVariantMap word = entry.toMap();
            const int chars = qMax(1, word.value(QStringLiteral("s")).toString().size());
            const double start = word.value(QStringLiteral("t")).toDouble();
            const double end = word.value(QStringLiteral("end")).toDouble();
            if (positionSeconds >= end) {
                completedChars += chars;
                continue;
            }
            if (positionSeconds > start && end > start)
                completedChars += chars * (positionSeconds - start) / (end - start);
            break;
        }
        return qBound(0.0, completedChars / qMax(1, totalChars), 1.0);
    }
    const double start = line.value(QStringLiteral("t")).toDouble();
    const double end = line.value(QStringLiteral("end"), start + 5.0).toDouble();
    if (end <= start)
        return 1.0;
    return qBound(0.0, (positionSeconds - start) / (end - start), 1.0);
}

}  // namespace melodex
