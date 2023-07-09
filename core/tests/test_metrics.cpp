#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <thread>

#include "modules/metrics/metrics.h"

TEST_CASE("metrics tracker reports zeros initially", "[metrics]") {
    grav::MetricsTracker m;
    const auto snap = m.snapshot();
    REQUIRE(snap.fps == 0.0F);
    REQUIRE(snap.frame_time_ms == 0.0F);
    REQUIRE(snap.pairs_per_sec == 0.0F);
}

TEST_CASE("metrics tracker fps becomes positive after frames", "[metrics]") {
    grav::MetricsTracker m;
    for (int i = 0; i < 5; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        m.record_frame(64);
    }
    const auto snap = m.snapshot();
    REQUIRE(snap.fps > 0.0F);
    REQUIRE(snap.frame_time_ms > 0.0F);
}
