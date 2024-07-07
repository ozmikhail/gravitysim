#pragma once

#include <cstddef>
#include <filesystem>
#include <string>

struct WindowConfig {
    int width = 1600;
    int height = 1000;
    std::string title = "gravitysim";
    bool vsync = true;
};

struct SimulationConfig {
    std::size_t default_particle_count = 4096;
    std::size_t max_particles = 65536;
    std::string default_integrator = "leapfrog";
    std::string default_backend = "auto";
    std::string default_kernel = "tiled";
    std::string default_force = "direct";
    float barnes_hut_theta = 0.6F;
};

struct TrailsConfig {
    bool enabled = true;
    std::size_t max_history = 64;
};

struct ExportConfig {
    std::filesystem::path positions;
    std::filesystem::path frames;
};

struct Config {
    WindowConfig window;
    SimulationConfig simulation;
    TrailsConfig trails;
    ExportConfig output;

    static Config load(const std::filesystem::path& path);
};
