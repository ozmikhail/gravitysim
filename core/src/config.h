#ifndef GRAV_CONFIG_H
#define GRAV_CONFIG_H

#include <cstddef>
#include <filesystem>
#include <string>

inline constexpr int DEFAULT_WINDOW_WIDTH = 1600;
inline constexpr int DEFAULT_WINDOW_HEIGHT = 1000;
inline constexpr std::size_t DEFAULT_PARTICLE_COUNT = 4096;
inline constexpr std::size_t MAX_PARTICLES = 65536;
inline constexpr float DEFAULT_THETA = 0.6F;
inline constexpr std::size_t MAX_TRAIL_HISTORY = 64;

struct WindowConfig {
  int width = DEFAULT_WINDOW_WIDTH;
  int height = DEFAULT_WINDOW_HEIGHT;
  std::string title = "gravitysim";
  bool vsync = true;
};

struct SimulationConfig {
  std::size_t default_particle_count = DEFAULT_PARTICLE_COUNT;
  std::size_t max_particles = MAX_PARTICLES;
  std::string default_integrator = "leapfrog";
  std::string default_backend = "auto";
  std::string default_kernel = "tiled";
  std::string default_force = "direct";
  float barnes_hut_theta = DEFAULT_THETA;
};

struct TrailsConfig {
  bool enabled = true;
  std::size_t max_history = MAX_TRAIL_HISTORY;
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

#endif // GRAV_CONFIG_H
