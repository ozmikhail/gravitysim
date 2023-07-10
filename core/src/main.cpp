#include <cstdlib>
#include <exception>
#include <filesystem>
#include <format>
#include <iostream>
#include <string>

#include "config.h"
#include "error.h"
#include "lib/gl/gl.h"
#include "lib/imgui_layer/imgui_layer.h"
#include "lib/window/window.h"
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

    grav::Simulation simulation;
    simulation.backend = resolve_backend(cfg.simulation.default_backend);
    simulation.params.integrator = parse_integrator(cfg.simulation.default_integrator);
    simulation.params.kernel_variant = parse_kernel(cfg.simulation.default_kernel);

    grav::reset(simulation, "colliding_galaxies", cfg.simulation.default_particle_count);

    grav::ParticleRenderer renderer(cfg.simulation.max_particles);
    if (simulation.backend == grav::Backend::Cuda) {
        simulation.output_vbo = renderer.position_vbo();
    }

    grav::MetricsTracker metrics;
    grav::ui::ControlsState controls{};
    controls.current_scenario = "colliding_galaxies";

    while (!window.should_close()) {
        window.poll_events();

        const bool advance = !controls.paused || controls.step_once_clicked;
        if (advance) {
            grav::step(simulation);
        }
        if (controls.reset_clicked) {
            grav::reset(simulation, controls.current_scenario, cfg.simulation.default_particle_count);
        }
        if (controls.scenario_changed) {
            grav::reset(simulation, controls.current_scenario, cfg.simulation.default_particle_count);
        }

        if (simulation.backend == grav::Backend::Cpu) {
            renderer.upload_positions(simulation.particles);
        }
        renderer.upload_speeds(simulation.particles);

        grav::imgui::begin_frame();
        metrics.record_frame(simulation.particles.count());
        grav::ui::draw_metrics_overlay(metrics.snapshot());
        grav::ui::draw_controls(controls, simulation.params);

        const auto [fb_w, fb_h] = window.framebuffer_size();
        grav::gl::set_viewport(fb_w, fb_h);
        grav::gl::clear(0.05F, 0.05F, 0.08F, 1.0F);
        renderer.draw(fb_w, fb_h, simulation.particles.count());

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
