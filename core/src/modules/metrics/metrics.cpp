#include "modules/metrics/metrics.h"

#include <chrono>
#include <cstddef>

namespace grav {

namespace {

double ema(double current, double instant, double alpha) {
    if (current == 0.0) {
        return instant;
    }
    return (current * (1.0 - alpha)) + (instant * alpha);
}

}

MetricsTracker::MetricsTracker() : last_frame_(Clock::now()) {}

void MetricsTracker::record_frame(std::size_t particle_count) {
    const auto now = Clock::now();
    if (first_frame_) {
        last_frame_ = now;
        first_frame_ = false;
        return;
    }

    const auto delta = std::chrono::duration<double>(now - last_frame_).count();
    last_frame_ = now;
    if (delta <= 0.0) {
        return;
    }

    const double instant_fps = 1.0 / delta;
    const auto n = static_cast<double>(particle_count);
    const double instant_pairs = (n * n) / delta;

    current_.fps = ema(current_.fps, instant_fps, smoothing_alpha_);
    current_.frame_time_ms = delta * 1000.0;
    current_.pairs_per_sec = ema(current_.pairs_per_sec, instant_pairs, smoothing_alpha_);
}

}
