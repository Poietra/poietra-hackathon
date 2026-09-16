//! Pure, time-addressable motion evaluation. No browser or UI dependencies.

#[no_mangle]
pub extern "C" fn ease(value: f64, kind: u32) -> f64 {
    let t = if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 };
    match kind {
        1 => if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 },
        2 => t * t * t,
        3 => 1.0 - (1.0 - t).powi(3),
        _ => t,
    }
}

#[no_mangle]
pub extern "C" fn track_progress(time: f64, start: f64, duration: f64, easing: u32) -> f64 {
    if time < start { return 0.0; }
    if duration <= 0.0 { return 1.0; }
    ease((time - start) / duration, easing)
}

/// Cubic easing is y at the parameter where x equals elapsed time. Evaluating
/// y(time) directly would ignore the horizontal handles and change the curve.
#[no_mangle]
pub extern "C" fn cubic_bezier_ease(value: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let time = if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 };
    if time == 0.0 || time == 1.0 { return time; }
    // Validated project data stays in the unit square. Keep raw kernel calls
    // finite too; malformed controls degrade to linear instead of propagating NaN.
    if ![x1, y1, x2, y2].iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0) { return time; }
    let mut low = 0.0;
    let mut high = 1.0;
    // x is monotone on the unit square, including reversed horizontal handles.
    // Bisection also handles zero endpoint/midpoint slopes without division.
    // Bound parameter error rather than x error near those flat tangents.
    for _ in 0..48 {
        let parameter = (low + high) * 0.5;
        let x = cubic_bezier(0.0, x1, x2, 1.0, parameter);
        if x == time { return cubic_bezier(0.0, y1, y2, 1.0, parameter); }
        if x < time { low = parameter; } else { high = parameter; }
    }
    cubic_bezier(0.0, y1, y2, 1.0, (low + high) * 0.5).clamp(0.0, 1.0)
}

#[no_mangle]
pub extern "C" fn interpolate(from: f64, to: f64, progress: f64) -> f64 {
    from + (to - from) * progress.clamp(0.0, 1.0)
}

#[no_mangle]
pub extern "C" fn cubic_bezier(p0: f64, p1: f64, p2: f64, p3: f64, progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    let u = 1.0 - t;
    u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_clamps_to_its_own_interval() {
        assert_eq!(track_progress(399.0, 400.0, 400.0, 1), 0.0);
        assert_eq!(track_progress(600.0, 400.0, 400.0, 1), 0.5);
        assert_eq!(track_progress(900.0, 400.0, 400.0, 1), 1.0);
        assert_eq!(track_progress(400.0, 400.0, 0.0, 1), 1.0);
    }

    #[test]
    fn independent_tracks_overlap() {
        assert_eq!(track_progress(600.0, 0.0, 600.0, 1), 1.0);
        assert_eq!(track_progress(600.0, 400.0, 400.0, 1), 0.5);
    }

    #[test]
    fn bezier_reaches_composition_endpoints() {
        assert_eq!(cubic_bezier(245.0, 505.0, 665.0, 955.0, 0.0), 245.0);
        assert_eq!(cubic_bezier(245.0, 505.0, 665.0, 955.0, 1.0), 955.0);
        assert_eq!(cubic_bezier(0.0, 0.0, 10.0, 10.0, 0.5), 5.0);
    }

    #[test]
    fn custom_easing_inverts_time_instead_of_evaluating_y_at_time() {
        // x(u) = u³, so time=1/8 corresponds to u=1/2 and y=1/2.
        assert_eq!(cubic_bezier_ease(0.125, 0.0, 0.0, 0.0, 1.0), 0.5);
        assert_ne!(cubic_bezier(0.0, 0.0, 1.0, 1.0, 0.125), 0.5);
        // The symmetric flat endpoint is equally valid.
        assert_eq!(cubic_bezier_ease(0.875, 1.0, 0.0, 1.0, 1.0), 0.5);
    }

    #[test]
    fn diagonal_custom_curves_are_linear_even_with_uneven_handles() {
        for (x1, x2) in [(0.0, 0.0), (1.0, 1.0), (1.0, 0.0), (0.15, 0.85)] {
            for sample in 0..=100 {
                let time = sample as f64 / 100.0;
                assert!((cubic_bezier_ease(time, x1, x1, x2, x2) - time).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn custom_easing_is_finite_monotone_and_clamped_at_degenerate_handles() {
        for (x1, y1, x2, y2) in [(0.0, 1.0, 0.0, 1.0), (1.0, 0.0, 1.0, 0.0), (1.0, 0.0, 0.0, 1.0), (1.0, 1.0, 0.0, 0.0)] {
            assert_eq!(cubic_bezier_ease(-1.0, x1, y1, x2, y2), 0.0);
            assert_eq!(cubic_bezier_ease(2.0, x1, y1, x2, y2), 1.0);
            let mut previous = 0.0;
            for sample in 0..=1000 {
                let progress = cubic_bezier_ease(sample as f64 / 1000.0, x1, y1, x2, y2);
                assert!(progress.is_finite() && progress >= previous && progress <= 1.0);
                previous = progress;
            }
        }
        assert_eq!(cubic_bezier_ease(f64::NAN, 0.25, 0.1, 0.25, 1.0), 0.0);
        assert_eq!(cubic_bezier_ease(0.25, f64::NAN, 0.1, 0.25, 1.0), 0.25);
        assert_eq!(cubic_bezier_ease(0.25, 0.1, -0.1, 0.25, 1.0), 0.25);
    }

    #[test]
    fn preset_quarter_points_stay_unchanged() {
        assert_eq!(track_progress(250.0, 0.0, 1000.0, 0), 0.25);
        assert_eq!(track_progress(250.0, 0.0, 1000.0, 1), 0.0625);
        assert_eq!(track_progress(250.0, 0.0, 1000.0, 2), 0.015625);
        assert_eq!(track_progress(250.0, 0.0, 1000.0, 3), 0.578125);
    }
}
