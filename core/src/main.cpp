#include <cstdlib>
#include <exception>
#include <filesystem>
#include <format>
#include <iostream>
#include <string>
#include <vector>

#include "config.h"
#include "error.h"
#include "lib/gl/gl.h"
#include "lib/imgui_layer/imgui_layer.h"
#include "lib/window/window.h"
#include "modules/export/export_writer.h"
#include "modules/metrics/metrics.h"
#include "modules/render/render.h"
#include "modules/sim/sim.h"
#include "modules/ui/ui.h"

namespace {

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

grav::Integrator parse_integrator(const std::string& s) {
    if (s == "leapfrog") {
        return grav::Integrator::Leapfrog;
    }
    return grav::Integrator::Euler;
}

grav::KernelVariant parse_kernel(const std::string& s) {
    if (s == "tiled") {
        return grav::KernelVariant::Tiled;
    }
    if (s == "float4") {
        return grav::KernelVariant::Float4;
    }
    return grav::KernelVariant::Global;
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
    std::cout << std::format(
        "gl: renderer={} version={}\n",
        grav::gl::renderer() != nullptr ? grav::gl::renderer() : "(null)",
        grav::gl::version() != nullptr ? grav::gl::version() : "(null)"
    );

    const grav::imgui::Session imgui_session(window.handle(), window.dpi_scale());

    grav::ParticleRenderer renderer(cfg.simulation.max_particles, cfg.trails.max_history);
    grav::Simulation simulation;
    simulation.backend = resolve_backend(cfg.simulation.default_backend);
    simulation.params.integrator = parse_integrator(cfg.simulation.default_integrator);
    simulation.params.kernel_variant = parse_kernel(cfg.simulation.default_kernel);
    if (cfg.simulation.default_force == "barnes_hut") {
        simulation.params.force_model = grav::ForceModel::BarnesHut;
    }
    simulation.params.barnes_hut_theta = cfg.simulation.barnes_hut_theta;

    grav::reset(simulation, "colliding_galaxies", cfg.simulation.default_particle_count);

    renderer.upload_positions(simulation.particles);
    if (simulation.backend == grav::Backend::Cuda) {
        simulation.output_vbo = renderer.position_vbo();
    }

    grav::MetricsTracker metrics;
    grav::ui::ControlsState controls{};
    controls.current_scenario = "colliding_galaxies";
    controls.trails_enabled = cfg.trails.enabled;
    controls.trail_history = cfg.trails.max_history;
    controls.max_particles = cfg.simulation.max_particles;
    bool trails_were_enabled = controls.trails_enabled;
    if (controls.trails_enabled) {
        renderer.record_trails(simulation.particles);
    }

    grav::ExportWriter output(cfg.output.positions, cfg.output.frames);
    grav::FrameSample sample;
    std::vector<unsigned char> pixels;
    bool first_frame = true;
    while (!window.should_close()) {
        window.poll_events();

        const bool reset = controls.reset_clicked || controls.scenario_changed;
        const bool advance = !first_frame && !reset && (!controls.paused || controls.step_once_clicked);
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
        renderer.upload_speeds(simulation.particles);

        grav::imgui::begin_frame();
        metrics.record_frame(simulation.particles.count());
        grav::ui::draw_metrics_overlay(metrics.snapshot());
        grav::ui::draw_controls(controls, simulation);

        const auto [fb_w, fb_h] = window.framebuffer_size();
        grav::gl::set_viewport(fb_w, fb_h);
        grav::gl::clear(0.05F, 0.05F, 0.08F, 1.0F);
        renderer.draw(fb_w, fb_h, simulation.particles.count());

        if (first_frame || reset || advance) {
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
        first_frame = false;
        grav::imgui::end_frame();
        window.swap_buffers();
    }

    return EXIT_SUCCESS;
}

}

int main(int argc, char** argv) {
    std::filesystem::path config_path = "core/config.toml";
    if (argc > 1) {
        config_path = argv[1];
    }

    try {
        const Config cfg = Config::load(config_path);
        return run(cfg);
    } catch (const AppError& e) {
        std::cerr << std::format("error[{}]: {}\n", e.kind(), e.what());
        return EXIT_FAILURE;
    } catch (const std::exception& e) {
        std::cerr << std::format("error: {}\n", e.what());
        return EXIT_FAILURE;
    } catch (...) {
        std::cerr << "error: unknown exception\n";
        return EXIT_FAILURE;
    }
}
