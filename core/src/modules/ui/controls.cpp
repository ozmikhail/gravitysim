#include "modules/ui/ui.h"

#include <imgui.h>

#include "modules/scenarios/scenarios.h"
#include "modules/sim/params.h"

namespace grav::ui {

namespace {

const char* integrator_label(Integrator integrator) {
    switch (integrator) {
    case Integrator::Euler:
        return "euler";
    case Integrator::Leapfrog:
        return "leapfrog";
    }
    return "unknown";
}

const char* kernel_label(KernelVariant variant) {
    switch (variant) {
    case KernelVariant::Global:
        return "global";
    case KernelVariant::Tiled:
        return "tiled";
    case KernelVariant::Float4:
        return "float4";
    }
    return "unknown";
}

}

void draw_controls(ControlsState& state, SimParams& params) {
    state.step_once_clicked = false;
    state.reset_clicked = false;
    state.scenario_changed = false;

    if (ImGui::Begin("controls")) {
        if (ImGui::Button(state.paused ? "play" : "pause")) {
            state.paused = !state.paused;
        }
        ImGui::SameLine();
        if (ImGui::Button("step")) {
            state.step_once_clicked = true;
        }
        ImGui::SameLine();
        if (ImGui::Button("reset")) {
            state.reset_clicked = true;
        }

        ImGui::Separator();
        if (state.trail_history >= 2) {
            ImGui::Checkbox("trails", &state.trails_enabled);
        }
        ImGui::SliderFloat("dt", &params.dt, 0.0001F, 0.05F, "%.4f");
        ImGui::SliderFloat("G", &params.gravity, 0.0F, 5.0F, "%.3f");
        ImGui::SliderFloat("softening", &params.softening, 0.001F, 0.5F, "%.3f");

        ImGui::Separator();
        if (ImGui::BeginCombo("integrator", integrator_label(params.integrator))) {
            for (auto candidate : {Integrator::Euler, Integrator::Leapfrog}) {
                const bool selected = params.integrator == candidate;
                if (ImGui::Selectable(integrator_label(candidate), selected)) {
                    params.integrator = candidate;
                }
                if (selected) {
                    ImGui::SetItemDefaultFocus();
                }
            }
            ImGui::EndCombo();
        }

        if (ImGui::BeginCombo("cuda kernel", kernel_label(params.kernel_variant))) {
            for (auto candidate :
                 {KernelVariant::Global, KernelVariant::Tiled, KernelVariant::Float4}) {
                const bool selected = params.kernel_variant == candidate;
                if (ImGui::Selectable(kernel_label(candidate), selected)) {
                    params.kernel_variant = candidate;
                }
                if (selected) {
                    ImGui::SetItemDefaultFocus();
                }
            }
            ImGui::EndCombo();
        }

        ImGui::Separator();
        if (ImGui::BeginCombo("scenario", state.current_scenario.c_str())) {
            for (auto candidate : grav::scenarios::available) {
                if (candidate == "solar_system" && state.max_particles < 9) {
                    continue;
                }
                const bool selected = state.current_scenario == candidate;
                if (ImGui::Selectable(std::string(candidate).c_str(), selected)) {
                    if (state.current_scenario != candidate) {
                        state.current_scenario = candidate;
                        state.scenario_changed = true;
                    }
                }
                if (selected) {
                    ImGui::SetItemDefaultFocus();
                }
            }
            ImGui::EndCombo();
        }
    }
    ImGui::End();
}

}
