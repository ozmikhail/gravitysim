#pragma once

#include <cmath>
#include <cstddef>
#include <vector>

namespace grav {

struct Vec3 {
    float x = 0.0F;
    float y = 0.0F;
    float z = 0.0F;

    Vec3 operator+(const Vec3& o) const noexcept { return {x + o.x, y + o.y, z + o.z}; }
    Vec3 operator-(const Vec3& o) const noexcept { return {x - o.x, y - o.y, z - o.z}; }
    Vec3 operator*(float s) const noexcept { return {x * s, y * s, z * s}; }

    Vec3& operator+=(const Vec3& o) noexcept {
        x += o.x;
        y += o.y;
        z += o.z;
        return *this;
    }
    Vec3& operator-=(const Vec3& o) noexcept {
        x -= o.x;
        y -= o.y;
        z -= o.z;
        return *this;
    }
};

inline float length_squared(const Vec3& v) noexcept {
    return (v.x * v.x) + (v.y * v.y) + (v.z * v.z);
}

inline float length(const Vec3& v) noexcept { return std::sqrt(length_squared(v)); }

struct Particles {
    std::vector<Vec3> positions;
    std::vector<Vec3> velocities;
    std::vector<Vec3> accelerations;
    std::vector<float> masses;

    [[nodiscard]] std::size_t count() const noexcept { return positions.size(); }

    void resize(std::size_t n);
    void clear();
};

}
