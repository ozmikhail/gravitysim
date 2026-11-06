#ifndef GRAV_MODULES_SIM_PARTICLES_H
#define GRAV_MODULES_SIM_PARTICLES_H

#include <cmath>
#include <cstddef>
#include <iterator>
#include <vector>

namespace grav {

struct Vec3 {
  float x = 0.0F;
  float y = 0.0F;
  float z = 0.0F;
};

inline Vec3 operator+(const Vec3& lhs, const Vec3& rhs) noexcept {
  return {.x = lhs.x + rhs.x, .y = lhs.y + rhs.y, .z = lhs.z + rhs.z};
}

inline Vec3 operator-(const Vec3& lhs, const Vec3& rhs) noexcept {
  return {.x = lhs.x - rhs.x, .y = lhs.y - rhs.y, .z = lhs.z - rhs.z};
}

inline Vec3 operator*(const Vec3& vec, float scalar) noexcept {
  return {.x = vec.x * scalar, .y = vec.y * scalar, .z = vec.z * scalar};
}

inline Vec3& operator+=(Vec3& lhs, const Vec3& rhs) noexcept {
  lhs.x += rhs.x;
  lhs.y += rhs.y;
  lhs.z += rhs.z;
  return lhs;
}

inline Vec3& operator-=(Vec3& lhs, const Vec3& rhs) noexcept {
  lhs.x -= rhs.x;
  lhs.y -= rhs.y;
  lhs.z -= rhs.z;
  return lhs;
}

inline float length_squared(const Vec3& vec) noexcept {
  return (vec.x * vec.x) + (vec.y * vec.y) + (vec.z * vec.z);
}

inline float length(const Vec3& vec) noexcept { return std::sqrt(length_squared(vec)); }

struct Particles {
  std::vector<Vec3> positions;
  std::vector<Vec3> velocities;
  std::vector<Vec3> accelerations;
  std::vector<float> masses;
  std::vector<std::size_t> ids;
  std::vector<float> charges;
};

[[nodiscard]] inline std::size_t count_particles(const Particles& particles) noexcept {
  return particles.positions.size();
}

[[nodiscard]] inline float charge_of(const Particles& particles, std::size_t index) noexcept {
  return index < particles.charges.size()
             ? *std::next(particles.charges.begin(), static_cast<std::ptrdiff_t>(index))
             : 0.0F;
}

[[nodiscard]] inline std::size_t id_of(const Particles& particles, std::size_t index) noexcept {
  return particles.ids.size() == count_particles(particles)
             ? *std::next(particles.ids.begin(), static_cast<std::ptrdiff_t>(index))
             : index;
}

void resize_particles(Particles& particles, std::size_t count);
void clear_particles(Particles& particles);

} // namespace grav

#endif // GRAV_MODULES_SIM_PARTICLES_H
