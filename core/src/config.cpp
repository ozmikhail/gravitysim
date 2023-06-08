#include "config.h"

#include <toml++/toml.hpp>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <initializer_list>
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
    if (cfg.simulation.default_particle_count > cfg.simulation.max_particles) {
        throw AppError::invalid_input(
            "config: default_particle_count exceeds max_particles"
        );
    }

    constexpr std::size_t trail_byte_cap = 512ULL * 1024 * 1024;
    constexpr std::size_t bytes_per_position = sizeof(float) * 3;
    const std::size_t trail_bytes =
        cfg.trails.max_history * cfg.simulation.max_particles * bytes_per_position;
    if (trail_bytes > trail_byte_cap) {
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

    cfg.trails.enabled = section_value<bool>(tbl, "trails", "enabled", cfg.trails.enabled);
    cfg.trails.max_history = static_cast<std::size_t>(
        section_value<int64_t>(
            tbl, "trails", "max_history", static_cast<int64_t>(cfg.trails.max_history)
        )
    );

    validate(cfg);
    return cfg;
}
