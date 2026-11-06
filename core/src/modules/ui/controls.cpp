#include "modules/scenarios/scenarios.h"
#include "modules/sim/integrator.h"
#include "modules/sim/params.h"
#include "modules/sim/simulation.h"
#include "modules/ui/ui.h"

#include <cstddef>
#include <imgui.h>
#include <string>

namespace grav::ui {

namespace {

constexpr std::size_t SOLAR_SYSTEM_MIN_PARTICLES = 9;

const char* integrator_label(Integrator integrator) {
  switch (integrator) {
  case Integrator::Euler:
    return "euler";
  case Integrator::Leapfrog:
    return "leapfrog";
  }
  return "unknown";
}

const char* force_label(ForceModel model) {
  switch (model) {
  case ForceModel::Direct:
    return "direct gravity";
  case ForceModel::BarnesHut:
    return "Barnes-Hut gravity";
  case ForceModel::Sph:
    return "SPH fluid";
  case ForceModel::Electrostatic:
    return "electrostatic";
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

void draw_playback_buttons(ControlsState& state) {
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
}

void draw_sph_sliders(SimParams& params) {
  constexpr float gravity_max = 5.0F;
  constexpr float radius_min = 0.02F;
  constexpr float radius_max = 0.5F;
  constexpr float density_min = 0.1F;
  constexpr float density_max = 5.0F;
  constexpr float stiffness_max = 25.0F;
  constexpr float viscosity_max = 0.1F;
  ImGui::SliderFloat("downward gravity", &params.gravity, 0.0F, gravity_max, "%.3f");
  ImGui::SliderFloat("smoothing radius", &params.sph_radius, radius_min, radius_max, "%.3f");
  ImGui::SliderFloat("rest density", &params.sph_rest_density, density_min, density_max, "%.2f");
  ImGui::SliderFloat("stiffness", &params.sph_stiffness, 0.0F, stiffness_max, "%.2f");
  ImGui::SliderFloat("viscosity", &params.sph_viscosity, 0.0F, viscosity_max, "%.3f");
}

void draw_gravity_sliders(SimParams& params) {
  constexpr float strength_max = 5.0F;
  constexpr float softening_min = 0.001F;
  constexpr float softening_max = 0.5F;
  constexpr float merge_min = 0.0001F;
  constexpr float merge_max = 0.1F;
  if (params.force_model == ForceModel::Electrostatic) {
    ImGui::SliderFloat("Coulomb strength", &params.coulomb_strength, 0.0F, strength_max, "%.3f");
  } else {
    ImGui::SliderFloat("G", &params.gravity, 0.0F, strength_max, "%.3f");
  }
  ImGui::SliderFloat("softening", &params.softening, softening_min, softening_max, "%.3f");
  ImGui::Checkbox("merge on collision", &params.merge_on_collision);
  if (params.merge_on_collision) {
    ImGui::SliderFloat("merge distance", &params.merge_radius, merge_min, merge_max, "%.4f");
  }
}

void draw_simulation_sliders(SimParams& params) {
  constexpr float dt_min = 0.0001F;
  constexpr float dt_max = 0.05F;
  ImGui::SliderFloat("dt", &params.dt, dt_min, dt_max, "%.4f");
  if (params.force_model == ForceModel::Sph) {
    draw_sph_sliders(params);
  } else {
    draw_gravity_sliders(params);
  }
}

void draw_integrator_combo(SimParams& params) {
  if (ImGui::BeginCombo("integrator", integrator_label(params.integrator))) {
    for (const auto candidate : {Integrator::Euler, Integrator::Leapfrog}) {
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
}

void draw_force_model_combo(SimParams& params) {
  if (ImGui::BeginCombo("force model", force_label(params.force_model))) {
    for (const auto candidate : {
             ForceModel::Direct,
             ForceModel::BarnesHut,
             ForceModel::Sph,
             ForceModel::Electrostatic,
         }) {
      const bool selected = params.force_model == candidate;
      if (ImGui::Selectable(force_label(candidate), selected)) {
        params.force_model = candidate;
      }
      if (selected) {
        ImGui::SetItemDefaultFocus();
      }
    }
    ImGui::EndCombo();
  }
  if (params.force_model == ForceModel::BarnesHut) {
    constexpr float theta_max = 1.5F;
    ImGui::SliderFloat("theta", &params.barnes_hut_theta, 0.0F, theta_max, "%.2f");
  }
}

void draw_backend_settings(const Simulation& sim, SimParams& params) {
  const bool cuda = active_backend(sim) == Backend::Cuda;
  ImGui::TextUnformatted(cuda ? "backend: CUDA" : "backend: CPU");
  if (cuda && ImGui::BeginCombo("cuda kernel", kernel_label(params.kernel_variant))) {
    for (const auto candidate :
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
}

void draw_scenario_combo(ControlsState& state, SimParams& params) {
  if (ImGui::BeginCombo("scenario", state.current_scenario.c_str())) {
    for (const auto candidate : grav::scenarios::AVAILABLE) {
      if (candidate == "solar_system" && state.max_particles < SOLAR_SYSTEM_MIN_PARTICLES) {
        continue;
      }
      const bool selected = state.current_scenario == candidate;
      if (ImGui::Selectable(std::string(candidate).c_str(), selected)) {
        if (state.current_scenario != candidate) {
          state.current_scenario = candidate;
          state.scenario_changed = true;
          if (candidate == "fluid_block") {
            params.force_model = ForceModel::Sph;
          } else if (candidate == "charge_cloud") {
            params.force_model = ForceModel::Electrostatic;
          } else if (params.force_model == ForceModel::Sph ||
                     params.force_model == ForceModel::Electrostatic) {
            params.force_model = ForceModel::Direct;
          }
        }
      }
      if (selected) {
        ImGui::SetItemDefaultFocus();
      }
    }
    ImGui::EndCombo();
  }
}

} // namespace

void draw_controls(ControlsState& state, Simulation& sim) {
  auto& params = sim.params;
  state.step_once_clicked = false;
  state.reset_clicked = false;
  state.scenario_changed = false;

  if (ImGui::Begin("controls")) {
    draw_playback_buttons(state);

    ImGui::Separator();
    if (state.trail_history >= 2) {
      ImGui::Checkbox("trails", &state.trails_enabled);
    }
    draw_simulation_sliders(params);

    ImGui::Separator();
    draw_integrator_combo(params);
    draw_force_model_combo(params);
    draw_backend_settings(sim, params);

    ImGui::Separator();
    draw_scenario_combo(state, params);
  }
  ImGui::End();
}

} // namespace grav::ui
