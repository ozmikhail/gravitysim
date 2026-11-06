#ifndef GRAV_MODULES_SCENARIOS_SCENARIOS_H
#define GRAV_MODULES_SCENARIOS_SCENARIOS_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace grav {
struct Particles;
}

namespace grav::scenarios {

enum class Seed : std::uint64_t {};

inline constexpr Seed DEFAULT_RANDOM_CLUSTER_SEED{42};
inline constexpr Seed DEFAULT_COLLIDING_GALAXIES_SEED{17};

void random_cluster(Particles& out, std::size_t n, Seed seed = DEFAULT_RANDOM_CLUSTER_SEED);

void solar_system(Particles& out);

void colliding_galaxies(Particles& out, std::size_t per_galaxy,
                        Seed seed = DEFAULT_COLLIDING_GALAXIES_SEED);

void fluid_block(Particles& out, std::size_t n);

void charge_cloud(Particles& out, std::size_t n);

inline constexpr std::array<std::string_view, 5> AVAILABLE = {
    "random_cluster", "solar_system", "colliding_galaxies", "fluid_block", "charge_cloud",
};

} // namespace grav::scenarios

#endif // GRAV_MODULES_SCENARIOS_SCENARIOS_H
