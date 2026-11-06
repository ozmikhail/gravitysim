#ifndef GRAV_MODULES_UI_UI_H
#define GRAV_MODULES_UI_UI_H

#include "modules/metrics/metrics.h"
#include "modules/sim/simulation.h"

#include <cstddef>
#include <string>

namespace grav::ui {

struct ControlsState {
  bool paused = false;
  bool step_once_clicked = false;
  bool reset_clicked = false;
  bool scenario_changed = false;
  bool trails_enabled = false;
  std::size_t trail_history = 0;
  std::size_t max_particles = 0;
  std::string current_scenario = "random_cluster";
};

void draw_metrics_overlay(const FrameMetrics& metrics, bool show_pairs);

void draw_controls(ControlsState& state, Simulation& sim);

} // namespace grav::ui

#endif // GRAV_MODULES_UI_UI_H
