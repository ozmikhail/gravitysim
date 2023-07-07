#pragma once

#include <string>

#include "modules/metrics/metrics.h"
#include "modules/sim/params.h"

namespace grav::ui {

struct ControlsState {
    bool paused = false;
    bool step_once_clicked = false;
    bool reset_clicked = false;
    bool scenario_changed = false;
    std::string current_scenario = "random_cluster";
};

void draw_metrics_overlay(const FrameMetrics& metrics);

void draw_controls(ControlsState& state, SimParams& params);

}
