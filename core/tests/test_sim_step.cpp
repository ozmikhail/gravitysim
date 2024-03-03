#include <catch2/catch_test_macros.hpp>

#include <cmath>

#include "error.h"
#include "modules/scenarios/scenarios.h"
#include "modules/sim/sim.h"

TEST_CASE("cpu step does not produce NaN positions", "[sim]") {
    grav::Simulation sim;
    sim.backend = grav::Backend::Cpu;
    sim.params.dt = 0.001F;
    sim.params.gravity = 1.0F;
    sim.params.softening = 0.05F;
    sim.params.integrator = grav::Integrator::Leapfrog;

    grav::scenarios::random_cluster(sim.particles, 64, 42);

    for (int i = 0; i < 100; ++i) {
        grav::step(sim);
    }

    for (const auto& p : sim.particles.positions) {
        REQUIRE(std::isfinite(p.x));
        REQUIRE(std::isfinite(p.y));
        REQUIRE(std::isfinite(p.z));
    }
}

TEST_CASE("reset to unknown scenario throws not_found", "[sim]") {
    grav::Simulation sim;
    REQUIRE_THROWS_AS(grav::reset(sim, "no_such_scenario", 64), AppError);
}

TEST_CASE("reset to random_cluster sizes particle arrays", "[sim]") {
    grav::Simulation sim;
    grav::reset(sim, "random_cluster", 256);
    REQUIRE(sim.particles.count() == 256);
    REQUIRE(sim.particles.positions.size() == 256);
    REQUIRE(sim.particles.velocities.size() == 256);
    REQUIRE(sim.particles.masses.size() == 256);
}

TEST_CASE("collisions merge connected bodies and preserve survivor IDs", "[sim][collision]") {
    grav::Simulation sim;
    sim.params.gravity = 0.0F;
    sim.params.dt = 0.0F;
    sim.params.merge_on_collision = true;
    sim.params.merge_radius = 0.1F;
    auto& p = sim.particles;
    p.resize(4);
    p.positions = {{0.0F, 0.0F, 0.0F}, {0.08F, 0.0F, 0.0F},
                   {0.16F, 0.0F, 0.0F}, {1.0F, 0.0F, 0.0F}};
    p.velocities = {{2.0F, 0.0F, 0.0F}, {-1.0F, 0.0F, 0.0F}, {}, {}};
    p.masses = {2.0F, 3.0F, 1.0F, 7.0F};

    grav::step(sim);

    REQUIRE(p.count() == 2);
    REQUIRE(p.id(0) == 0);
    REQUIRE(p.id(1) == 3);
    REQUIRE(p.masses[0] == 6.0F);
    REQUIRE(p.masses[1] == 7.0F);
    REQUIRE(std::abs(p.positions[0].x - 0.4F / 6.0F) < 1e-6F);
    REQUIRE(std::abs(p.velocities[0].x * p.masses[0] - 1.0F) < 1e-6F);
    REQUIRE(p.velocities.size() == p.count());
    REQUIRE(p.accelerations.size() == p.count());
    grav::step(sim);
    REQUIRE(p.id(1) == 3);
}
