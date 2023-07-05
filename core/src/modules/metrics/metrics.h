#pragma once

#include <chrono>
#include <cstddef>

namespace grav {

struct FrameMetrics {
    double fps = 0.0;
    double frame_time_ms = 0.0;
    double pairs_per_sec = 0.0;
};

class MetricsTracker {
public:
    MetricsTracker();

    void record_frame(std::size_t particle_count);

    [[nodiscard]] FrameMetrics snapshot() const noexcept { return current_; }

private:
    using Clock = std::chrono::steady_clock;

    Clock::time_point last_frame_;
    bool first_frame_ = true;
    FrameMetrics current_;
    double smoothing_alpha_ = 0.1;
};

}
