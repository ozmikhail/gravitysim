#include "modules/metrics/metrics.h"

#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstddef>
#include <thread>

TEST_CASE("metrics tracker reports zeros initially", "[metrics]") {
  const grav::MetricsTracker tracker;
  const auto snap = tracker.snapshot();
  REQUIRE(snap.fps == 0.0F);
  REQUIRE(snap.frame_time_ms == 0.0F);
  REQUIRE(snap.pairs_per_sec == 0.0F);
}

TEST_CASE("metrics tracker fps becomes positive after frames", "[metrics]") {
  constexpr int frame_count = 5;
  constexpr std::chrono::milliseconds frame_delay{5};
  constexpr std::size_t particle_count = 64;

  grav::MetricsTracker tracker;
  for (int i = 0; i < frame_count; ++i) {
    std::this_thread::sleep_for(frame_delay);
    tracker.record_frame(particle_count);
  }
  const auto snap = tracker.snapshot();
  REQUIRE(snap.fps > 0.0F);
  REQUIRE(snap.frame_time_ms > 0.0F);
}
