#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace grav {
struct Particles;
}

namespace grav::scenarios {

void random_cluster(Particles& out, std::size_t n, std::uint64_t seed = 42);

void solar_system(Particles& out);

void colliding_galaxies(Particles& out, std::size_t per_galaxy, std::uint64_t seed = 17);

void fluid_block(Particles& out, std::size_t n);

inline constexpr std::array<std::string_view, 4> available = {
    "random_cluster",
    "solar_system",
    "colliding_galaxies",
    "fluid_block",
};

}
