#include "config.h"

#include <toml++/toml.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <initializer_list>
#include <limits>
#include <string>
#include <string_view>

#include "error.h"

namespace {

template <typename T>
T section_value(
    const toml::table& tbl, std::string_view section, std::string_view key, T fallback
) {
    if (const auto* sec = tbl[section].as_table()) {
        if (auto v = (*sec)[key].value<T>()) {
            return *v;
        }
    }
    return fallback;
}

bool one_of(std::string_view value, std::initializer_list<std::string_view> allowed) {
    return std::any_of(
        allowed.begin(), allowed.end(), [&](std::string_view v) { return value == v; }
    );
}

void validate(const Config& cfg) {
    if (cfg.window.width <= 0 || cfg.window.height <= 0) {
        throw AppError::invalid_input("config: window dimensions must be positive");
    }
    if (cfg.simulation.max_particles > static_cast<std::size_t>(std::numeric_limits<int>::max() / 3)) {
        throw AppError::invalid_input("config: max_particles exceeds the particle index limit");
    }
    if (cfg.simulation.default_particle_count > cfg.simulation.max_particles) {
        throw AppError::invalid_input(
            "config: default_particle_count exceeds max_particles"
        );
    }

    constexpr std::size_t trail_byte_cap = 512ULL * 1024 * 1024;
    constexpr std::size_t bytes_per_position = sizeof(float) * 3;
    const auto max_trail_vertices = trail_byte_cap / bytes_per_position;
    if (cfg.trails.max_history > max_trail_vertices ||
        (cfg.trails.max_history >= 2 &&
         cfg.simulation.max_particles > max_trail_vertices / cfg.trails.max_history)) {
        throw AppError::invalid_input("config: trail buffer exceeds 512MB cap");
    }

    if (!one_of(cfg.simulation.default_integrator, {"euler", "leapfrog"})) {
        throw AppError::invalid_input(
            "config: default_integrator must be euler or leapfrog"
        );
    }
    if (!one_of(cfg.simulation.default_backend, {"auto", "cpu", "cuda"})) {
        throw AppError::invalid_input(
            "config: default_backend must be auto, cpu, or cuda"
        );
    }
    if (!one_of(cfg.simulation.default_force, {"direct", "barnes_hut"})) {
        throw AppError::invalid_input("config: default_force must be direct or barnes_hut");
    }
    const float theta = cfg.simulation.barnes_hut_theta;
    if (!std::isfinite(theta) || theta < 0.0F || theta > 1.5F) {
        throw AppError::invalid_input("config: barnes_hut_theta must be between 0 and 1.5");
    }
    if (!one_of(cfg.simulation.default_kernel, {"global", "tiled", "float4"})) {
        throw AppError::invalid_input(
            "config: default_kernel must be global, tiled, or float4"
        );
    }
}

}

Config Config::load(const std::filesystem::path& path) {
    if (!std::filesystem::exists(path)) {
        throw AppError::missing("config: file not found: " + path.string());
    }

    toml::table tbl;
    try {
        tbl = toml::parse_file(path.string());
    } catch (const toml::parse_error& e) {
        throw AppError::invalid_input(
            std::string("config: parse error: ") + e.what()
        );
    }

    Config cfg;

    cfg.window.width = static_cast<int>(
        section_value<int64_t>(tbl, "window", "width", cfg.window.width)
    );
    cfg.window.height = static_cast<int>(
        section_value<int64_t>(tbl, "window", "height", cfg.window.height)
    );
    cfg.window.title = section_value<std::string>(tbl, "window", "title", cfg.window.title);
    cfg.window.vsync = section_value<bool>(tbl, "window", "vsync", cfg.window.vsync);

    cfg.simulation.default_particle_count = static_cast<std::size_t>(
        section_value<int64_t>(
            tbl,
            "simulation",
            "default_particle_count",
            static_cast<int64_t>(cfg.simulation.default_particle_count)
        )
    );
    cfg.simulation.max_particles = static_cast<std::size_t>(
        section_value<int64_t>(
            tbl,
            "simulation",
            "max_particles",
            static_cast<int64_t>(cfg.simulation.max_particles)
        )
    );
    cfg.simulation.default_integrator = section_value<std::string>(
        tbl, "simulation", "default_integrator", cfg.simulation.default_integrator
    );
    cfg.simulation.default_backend = section_value<std::string>(
        tbl, "simulation", "default_backend", cfg.simulation.default_backend
    );
    cfg.simulation.default_kernel = section_value<std::string>(
        tbl, "simulation", "default_kernel", cfg.simulation.default_kernel
    );

    cfg.simulation.default_force = section_value<std::string>(
        tbl, "simulation", "default_force", cfg.simulation.default_force
    );
    cfg.simulation.barnes_hut_theta = section_value<float>(
        tbl, "simulation", "barnes_hut_theta", cfg.simulation.barnes_hut_theta
    );

    cfg.trails.enabled = section_value<bool>(tbl, "trails", "enabled", cfg.trails.enabled);
    cfg.trails.max_history = static_cast<std::size_t>(
        section_value<int64_t>(
            tbl, "trails", "max_history", static_cast<int64_t>(cfg.trails.max_history)
        )
    );

    validate(cfg);
    return cfg;
}
