#include "config.h"
#include "error.h"
#include "lib/gl/gl.h"
#include "lib/imgui_layer/imgui_layer.h"
#include "lib/window/window.h"
#include "modules/export/export_writer.h"
#include "modules/metrics/metrics.h"
#include "modules/render/particle_renderer.h"
#include "modules/sim/integrator.h"
#include "modules/sim/params.h"
#include "modules/sim/particles.h"
#include "modules/sim/simulation.h"
#include "modules/ui/ui.h"

#include <cstddef>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <format>
#include <iostream>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace {

inline constexpr float CLEAR_LEVEL = 0.05F;
inline constexpr float CLEAR_BLUE = 0.08F;

grav::Backend resolve_backend(const std::string& configured) {
#ifdef GRAV_HAVE_CUDA
  if (configured == "cpu") {
    return grav::Backend::Cpu;
  }
  return grav::Backend::Cuda;
#else
  if (configured == "cuda") {
    std::cerr << "warning: backend='cuda' but BUILD_CUDA=OFF; falling back to cpu\n";
  }
  return grav::Backend::Cpu;
#endif
}

grav::Integrator parse_integrator(const std::string& name) {
  if (name == "leapfrog") {
    return grav::Integrator::Leapfrog;
  }
  return grav::Integrator::Euler;
}

grav::KernelVariant parse_kernel(const std::string& name) {
  if (name == "tiled") {
    return grav::KernelVariant::Tiled;
  }
  if (name == "float4") {
    return grav::KernelVariant::Float4;
  }
  return grav::KernelVariant::Global;
}

const char* configure_simulation(const Config& cfg, grav::Simulation& simulation) {
  simulation.backend = resolve_backend(cfg.simulation.default_backend);
  simulation.params.integrator = parse_integrator(cfg.simulation.default_integrator);
  simulation.params.kernel_variant = parse_kernel(cfg.simulation.default_kernel);
  const char* scenario = "colliding_galaxies";
  if (cfg.simulation.default_force == "barnes_hut") {
    simulation.params.force_model = grav::ForceModel::BarnesHut;
  } else if (cfg.simulation.default_force == "sph") {
    simulation.params.force_model = grav::ForceModel::Sph;
    scenario = "fluid_block";
  } else if (cfg.simulation.default_force == "electrostatic") {
    simulation.params.force_model = grav::ForceModel::Electrostatic;
    scenario = "charge_cloud";
  }
  simulation.params.barnes_hut_theta = cfg.simulation.barnes_hut_theta;
  return scenario;
}

void advance_simulation(grav::Simulation& simulation, const grav::ui::ControlsState& controls,
                        grav::FrameSample& sample, const Config& cfg, bool reset, bool advance) {
  if (reset) {
    grav::reset(simulation, controls.current_scenario, cfg.simulation.default_particle_count);
    ++sample.run;
    sample.step = 0;
    sample.time = 0.0;
  } else if (advance) {
    grav::step(simulation);
    ++sample.step;
    sample.time += simulation.params.dt;
  }
}

void update_renderer(grav::ParticleRenderer& renderer, const grav::Simulation& simulation,
                     const grav::ui::ControlsState& controls, bool& trails_were_enabled, bool reset,
                     bool advance) {
  if (reset || (advance && !simulation.positions_on_device)) {
    renderer.upload_positions(simulation.particles);
  }
  if (reset || !controls.trails_enabled) {
    renderer.clear_trails();
  }
  if (controls.trails_enabled && (reset || advance || !trails_were_enabled)) {
    renderer.record_trails(simulation.particles);
  }
  trails_were_enabled = controls.trails_enabled;
  renderer.upload_appearance(simulation.particles,
                             simulation.params.force_model == grav::ForceModel::Electrostatic);
}

void write_outputs(grav::ExportWriter& output, grav::FrameSample& sample,
                   grav::Simulation& simulation, std::vector<unsigned char>& pixels, int fb_w,
                   int fb_h) {
  if (output.writes_positions()) {
    grav::sync_positions(simulation);
    output.write_positions(sample, simulation.particles);
  }
  if (output.writes_frames() && fb_w > 0 && fb_h > 0) {
    grav::gl::read_rgb(fb_w, fb_h, pixels);
    output.write_frame(sample, fb_w, fb_h, pixels);
  }
  ++sample.frame;
}

int run(const Config& cfg) {
  grav::Window window({
      .width = cfg.window.width,
      .height = cfg.window.height,
      .title = cfg.window.title,
      .vsync = cfg.window.vsync,
      .gl_major = 4,
      .gl_minor = 1,
  });

  grav::gl::init();
  std::cout << std::format("gl: renderer={} version={}\n", grav::gl::renderer(),
                           grav::gl::version());

  const grav::imgui::Session imgui_session(window.handle(), window.dpi_scale());

  grav::ParticleRenderer renderer(
      {.max_particles = cfg.simulation.max_particles, .trail_history = cfg.trails.max_history});
  grav::Simulation simulation;
  const char* scenario = configure_simulation(cfg, simulation);
  grav::reset(simulation, scenario, cfg.simulation.default_particle_count);

  renderer.upload_positions(simulation.particles);
  if (simulation.backend == grav::Backend::Cuda) {
    simulation.output_vbo = renderer.position_vbo();
  }

  grav::MetricsTracker metrics;
  grav::ui::ControlsState controls{};
  controls.current_scenario = scenario;
  controls.trails_enabled = cfg.trails.enabled;
  controls.trail_history = cfg.trails.max_history;
  controls.max_particles = cfg.simulation.max_particles;
  bool trails_were_enabled = controls.trails_enabled;
  if (controls.trails_enabled) {
    renderer.record_trails(simulation.particles);
  }

  grav::ExportWriter output({.positions = cfg.output.positions, .frames = cfg.output.frames});
  grav::FrameSample sample;
  std::vector<unsigned char> pixels;
  bool first_frame = true;
  while (!window.should_close()) {
    grav::Window::poll_events();

    const bool reset = controls.reset_clicked || controls.scenario_changed;
    const bool advance = !first_frame && !reset && (!controls.paused || controls.step_once_clicked);
    advance_simulation(simulation, controls, sample, cfg, reset, advance);
    update_renderer(renderer, simulation, controls, trails_were_enabled, reset, advance);

    grav::imgui::begin_frame();
    metrics.record_frame(count_particles(simulation.particles));
    grav::ui::draw_metrics_overlay(metrics.snapshot(), advance && simulation.params.force_model ==
                                                                      grav::ForceModel::Direct);
    grav::ui::draw_controls(controls, simulation);

    const auto [fb_w, fb_h] = window.framebuffer_size();
    grav::gl::set_viewport(fb_w, fb_h);
    grav::gl::clear(CLEAR_LEVEL, CLEAR_LEVEL, CLEAR_BLUE, 1.0F);
    renderer.draw({.width = fb_w, .height = fb_h}, count_particles(simulation.particles));

    if (first_frame || reset || advance) {
      write_outputs(output, sample, simulation, pixels, fb_w, fb_h);
    }
    first_frame = false;
    grav::imgui::end_frame();
    window.swap_buffers();
  }

  return EXIT_SUCCESS;
}

int report_app_error(const AppError& error) noexcept {
  try {
    std::cerr << std::format("error[{}]: {}\n", error.kind(), error.what());
  } catch (...) {
    return EXIT_FAILURE;
  }
  return EXIT_FAILURE;
}

int report_error(std::string_view message) noexcept {
  try {
    std::cerr << std::format("error: {}\n", message);
  } catch (...) {
    return EXIT_FAILURE;
  }
  return EXIT_FAILURE;
}

int report_unknown_error() noexcept {
  try {
    std::cerr << "error: unknown exception\n";
  } catch (...) {
    return EXIT_FAILURE;
  }
  return EXIT_FAILURE;
}

} // namespace

int main(int argc, char* const* argv) {
  try {
    const std::span<char* const> args(argv, static_cast<std::size_t>(argc));
    std::filesystem::path config_path = "core/config.toml";
    if (args.size() > 1) {
      config_path = args.subspan(1).front();
    }

    const Config cfg = Config::load(config_path);
    return run(cfg);
  } catch (const AppError& e) {
    return report_app_error(e);
  } catch (const std::exception& e) {
    return report_error(e.what());
  } catch (...) {
    return report_unknown_error();
  }
}
