#include <catch2/catch_test_macros.hpp>

#include "modules/scenarios/scenarios.h"
#include "modules/sim/particles.h"

TEST_CASE("solar_system seeds nine bodies with sun dominating", "[scenarios]") {
    grav::Particles p;
    grav::scenarios::solar_system(p);

    REQUIRE(p.count() == 9);
    const float sun_mass = p.masses[0];
    for (std::size_t i = 1; i < p.count(); ++i) {
        REQUIRE(sun_mass > p.masses[i]);
    }
}

TEST_CASE("random_cluster lies within unit sphere", "[scenarios]") {
    grav::Particles p;
    grav::scenarios::random_cluster(p, 256, 7);

    REQUIRE(p.count() == 256);
    for (std::size_t i = 0; i < p.count(); ++i) {
        REQUIRE(grav::length(p.positions[i]) <= 1.0F);
    }
}

TEST_CASE("colliding_galaxies has 2N particles total", "[scenarios]") {
    grav::Particles p;
    grav::scenarios::colliding_galaxies(p, 128, 13);

    REQUIRE(p.count() == 256);
}

TEST_CASE("random_cluster is reproducible by seed", "[scenarios]") {
    grav::Particles a;
    grav::Particles b;
    grav::scenarios::random_cluster(a, 32, 99);
    grav::scenarios::random_cluster(b, 32, 99);

    REQUIRE(a.count() == b.count());
    for (std::size_t i = 0; i < a.count(); ++i) {
        REQUIRE(a.positions[i].x == b.positions[i].x);
        REQUIRE(a.positions[i].y == b.positions[i].y);
        REQUIRE(a.positions[i].z == b.positions[i].z);
    }
}
