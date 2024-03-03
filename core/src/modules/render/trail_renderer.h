#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "modules/sim/particles.h"

namespace grav {

class TrailRenderer {
public:
    explicit TrailRenderer(std::size_t history) : history_(history) {}
    ~TrailRenderer();

    TrailRenderer(const TrailRenderer&) = delete;
    TrailRenderer& operator=(const TrailRenderer&) = delete;

    void clear() noexcept;
    void record(std::uint32_t position_vbo, const Particles& particles);
    void draw(float aspect) const;

private:
    void allocate(std::size_t count);

    std::size_t history_;
    std::size_t slots_ = 0;
    std::size_t next_ = 0;
    std::size_t samples_ = 0;
    std::uint32_t program_ = 0;
    std::uint32_t vao_ = 0;
    std::uint32_t history_vbo_ = 0;
    std::uint32_t index_buffer_ = 0;
    std::vector<Vec3> frame_;
    std::vector<Vec3> compact_frame_;
    std::vector<int> draw_counts_;
    std::vector<const void*> draw_offsets_;
};

}
