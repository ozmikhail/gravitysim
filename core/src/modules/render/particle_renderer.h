#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "modules/render/trail_renderer.h"

namespace grav {
struct Particles;
}

namespace grav {

class ParticleRenderer {
public:
    explicit ParticleRenderer(std::size_t max_particles, std::size_t trail_history = 0);
    ~ParticleRenderer();

    ParticleRenderer(const ParticleRenderer&) = delete;
    ParticleRenderer& operator=(const ParticleRenderer&) = delete;
    ParticleRenderer(ParticleRenderer&&) = delete;
    ParticleRenderer& operator=(ParticleRenderer&&) = delete;

    void upload_positions(const Particles& particles);
    void upload_speeds(const Particles& particles);
    void clear_trails() noexcept { trails_.clear(); }
    void record_trails(const Particles& particles) { trails_.record(position_vbo_, particles); }

    void draw(int framebuffer_width, int framebuffer_height, std::size_t count);

    [[nodiscard]] std::uint32_t position_vbo() const noexcept { return position_vbo_; }
    [[nodiscard]] std::size_t capacity() const noexcept { return capacity_; }

private:
    std::uint32_t program_ = 0;
    std::uint32_t vao_ = 0;
    std::uint32_t position_vbo_ = 0;
    std::uint32_t speed_vbo_ = 0;
    std::size_t capacity_ = 0;
    std::vector<float> speed_buffer_;
    TrailRenderer trails_;
};

}
