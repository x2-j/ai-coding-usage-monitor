use crate::models::{BurnRateProjection, ChartPoint, UsageSpike};
use chrono::{DateTime, Utc};

fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|dt| dt.with_timezone(&Utc))
}

pub fn latest_monotonic_segment(points: &[ChartPoint], pct_key: &str) -> Vec<ChartPoint> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut out = vec![points[points.len() - 1].clone()];
    let mut last = pct_value(&points[points.len() - 1], pct_key);
    for point in points.iter().rev().skip(1) {
        let current = pct_value(point, pct_key);
        if current.is_some() && last.is_some() && current.unwrap() > last.unwrap() {
            break;
        }
        out.push(point.clone());
        if current.is_some() {
            last = current;
        }
    }
    out.reverse();
    out
}

fn pct_value(point: &ChartPoint, key: &str) -> Option<f64> {
    if key == "weekly" {
        point.weekly_usage_percent
    } else {
        point.session_usage_percent
    }
}

pub fn calculate_burn(points: &[ChartPoint], pct_key: &str, current_pct: Option<f64>) -> BurnRateProjection {
    let segment = latest_monotonic_segment(points, pct_key);
    if segment.len() < 2 {
        return BurnRateProjection::reason("not enough data yet");
    }
    let first = &segment[0];
    let last = &segment[segment.len() - 1];
    let first_ts = match parse_ts(&first.timestamp_utc) {
        Some(v) => v,
        None => return BurnRateProjection::reason("invalid history timestamp"),
    };
    let last_ts = match parse_ts(&last.timestamp_utc) {
        Some(v) => v,
        None => return BurnRateProjection::reason("invalid history timestamp"),
    };
    let hours = (last_ts - first_ts).num_seconds() as f64 / 3600.0;
    if hours <= 0.0 {
        return BurnRateProjection::reason("not enough elapsed time");
    }
    let token_delta = (last.session_tokens - first.session_tokens).max(0) as f64;
    let rate_per_hour = token_delta / hours;
    let pct_first = pct_value(first, pct_key);
    let pct_last = pct_value(last, pct_key);
    let pct_per_hour = match (pct_first, pct_last) {
        (Some(a), Some(b)) if b >= a => Some((b - a) / hours),
        _ => None,
    };
    let minutes_until_limit = match (current_pct.or(pct_last), pct_per_hour) {
        (Some(current), Some(rate)) if rate > 0.0 && current < 100.0 => Some(((100.0 - current) / rate) * 60.0),
        (_, Some(_)) => None,
        _ => None,
    };
    BurnRateProjection {
        rate_per_minute: Some(rate_per_hour / 60.0),
        rate_per_hour: Some(rate_per_hour),
        pct_per_hour,
        minutes_until_limit,
        reason: if minutes_until_limit.is_none() { Some("usage is flat or reset recently".to_string()) } else { None },
    }
}

pub fn detect_spikes(points: &[ChartPoint]) -> Vec<UsageSpike> {
    let mut spikes = Vec::new();
    for pair in points.windows(2) {
        let prev = &pair[0];
        let next = &pair[1];
        let token_delta = next.session_tokens - prev.session_tokens;
        if token_delta < 10_000 {
            continue;
        }
        let input_delta = (next.input_tokens - prev.input_tokens).max(0);
        let output_delta = (next.output_tokens - prev.output_tokens).max(0);
        let pct_delta = match (prev.session_usage_percent, next.session_usage_percent) {
            (Some(a), Some(b)) if b >= a => Some(b - a),
            _ => None,
        };
        spikes.push(UsageSpike {
            timestamp_utc: next.timestamp_utc.clone(),
            token_increase: token_delta,
            input_increase: Some(input_delta),
            output_increase: Some(output_delta),
            pct_increase: pct_delta,
        });
    }
    spikes.sort_by(|a, b| b.token_increase.cmp(&a.token_increase));
    spikes.truncate(8);
    spikes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burn_rate_requires_two_points() {
        assert_eq!(calculate_burn(&[], "session", None).reason.as_deref(), Some("not enough data yet"));
    }
}
