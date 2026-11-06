#ifndef GRAV_MODULES_RENDER_PARTICLE_RENDERER_H
#define GRAV_MODULES_RENDER_PARTICLE_RENDERER_H

#include "modules/render/trail_renderer.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace grav {
struct Particles;
}

namespace grav {

struct RendererLimits {
  std::size_t max_particles = 0;
  std::size_t trail_history = 0;
};

struct FramebufferSize {
  int width;
  int height;
};

class ParticleRenderer {
public:
  explicit ParticleRenderer(const RendererLimits& limits);
  ~ParticleRenderer();

  ParticleRenderer(const ParticleRenderer&) = delete;
  ParticleRenderer& operator=(const ParticleRenderer&) = delete;
  ParticleRenderer(ParticleRenderer&&) = delete;
  ParticleRenderer& operator=(ParticleRenderer&&) = delete;

  void upload_positions(const Particles& particles) const;
  void upload_appearance(const Particles& particles, bool charge_colors);
  void clear_trails() noexcept { trails_.clear(); }
  void record_trails(const Particles& particles) { trails_.record(position_vbo_, particles); }

  void draw(FramebufferSize framebuffer, std::size_t count);

  [[nodiscard]] std::uint32_t position_vbo() const noexcept { return position_vbo_; }
  [[nodiscard]] std::size_t capacity() const noexcept { return capacity_; }

private:
  std::uint32_t program_ = 0;
  std::uint32_t vao_ = 0;
  std::uint32_t position_vbo_ = 0;
  std::uint32_t appearance_vbo_ = 0;
  std::size_t capacity_ = 0;
  std::vector<float> appearance_buffer_;
  bool charge_colors_ = false;
  TrailRenderer trails_;
};

} // namespace grav

#endif // GRAV_MODULES_RENDER_PARTICLE_RENDERER_H
