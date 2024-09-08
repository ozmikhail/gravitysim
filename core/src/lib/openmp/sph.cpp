#include "lib/openmp/sph.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <numbers>
#include <unordered_map>
#include <vector>

#include "modules/sim/params.h"
#include "modules/sim/particles.h"

namespace grav {

namespace {

constexpr float kWall = 0.95F;
constexpr float kRestitution = 0.35F;

struct Cell {
    int x;
    int y;
    int z;

    bool operator==(const Cell&) const = default;
};

struct CellHash {
    std::size_t operator()(Cell c) const noexcept {
        return (static_cast<std::size_t>(c.x) * 73856093U)
             ^ (static_cast<std::size_t>(c.y) * 19349663U)
             ^ (static_cast<std::size_t>(c.z) * 83492791U);
    }
};

class NeighborGrid {
public:
    NeighborGrid(const Particles& particles, float h) : h_(h) {
        for (std::size_t i = 0; i < particles.count(); ++i) {
            cells_[cell_at(particles.positions[i])].push_back(i);
        }
    }

    template <typename Visit>
    void visit(Vec3 position, Visit visit_particle) const {
        const auto c = cell_at(position);
        for (int x = c.x - 1; x <= c.x + 1; ++x) {
            for (int y = c.y - 1; y <= c.y + 1; ++y) {
                for (int z = c.z - 1; z <= c.z + 1; ++z) {
                    const auto bucket = cells_.find({x, y, z});
                    if (bucket != cells_.end()) {
                        for (const auto j : bucket->second) {
                            visit_particle(j);
                        }
                    }
                }
            }
        }
    }

private:
    Cell cell_at(Vec3 p) const {
        const auto cell_coord = [this](float v) {
            // Bound the grid even if a scene starts outside the fluid box.
            const float clamped = std::max(-kWall, std::min(kWall, v));
            return static_cast<int>(std::floor(clamped / h_));
        };
        return {cell_coord(p.x), cell_coord(p.y), cell_coord(p.z)};
    }

    float h_;
    std::unordered_map<Cell, std::vector<std::size_t>, CellHash> cells_;
};

void bounce(float& position, float& velocity) {
    if (position > kWall) {
        position = kWall;
        if (velocity > 0.0F) {
            velocity *= -kRestitution;
        }
    } else if (position < -kWall) {
        position = -kWall;
        if (velocity < 0.0F) {
            velocity *= -kRestitution;
        }
    }
}

}

void compute_sph(Particles& p, const SimParams& params) {
    const auto n = static_cast<std::ptrdiff_t>(p.count());
    const float h = std::max(0.02F, std::min(0.5F, params.sph_radius));
    const float h2 = h * h;
    const float h6 = h2 * h2 * h2;
    const float poly6 = 315.0F / (64.0F * std::numbers::pi_v<float> * h6 * h2 * h);
    const float spiky = 45.0F / (std::numbers::pi_v<float> * h6);
    const NeighborGrid grid(p, h);
    std::vector<float> density(n);
    std::vector<float> pressure_term(n);

#pragma omp parallel for schedule(static) default(none) shared(p, params, n, h2, poly6, grid, density, pressure_term)
    for (std::ptrdiff_t i = 0; i < n; ++i) {
        const Vec3 position = p.positions[i];
        float rho = 0.0F;
        grid.visit(position, [&](std::size_t j) {
            const float w = h2 - length_squared(p.positions[j] - position);
            if (w > 0.0F) {
                rho += p.masses[j] * poly6 * w * w * w;
            }
        });
        rho = std::max(rho, 1e-6F);
        density[i] = rho;
        const float pressure = params.sph_stiffness * std::max(0.0F, rho - params.sph_rest_density);
        pressure_term[i] = pressure / (rho * rho);
    }

#pragma omp parallel for schedule(static) default(none) shared(p, params, n, h, h2, spiky, grid, density, pressure_term)
    for (std::ptrdiff_t i = 0; i < n; ++i) {
        const Vec3 position = p.positions[i];
        Vec3 a{0.0F, -params.gravity, 0.0F};
        grid.visit(position, [&](std::size_t j) {
            const Vec3 delta = p.positions[j] - position;
            const float r2 = length_squared(delta);
            if (j == static_cast<std::size_t>(i) || !(r2 < h2)) {
                return;
            }
            const float r = std::sqrt(r2);
            const float w = h - r;
            const float weight = p.masses[j] * spiky * w;
            if (r > 0.0F) {
                a -= delta * (weight * w * (pressure_term[i] + pressure_term[j]) / r);
            }
            const float visc = 2.0F * params.sph_viscosity * weight / (density[i] + density[j]);
            a += (p.velocities[j] - p.velocities[i]) * visc;
        });
        p.accelerations[i] = a;
    }
}

void confine_fluid(Particles& p) {
    for (std::size_t i = 0; i < p.count(); ++i) {
        auto& position = p.positions[i];
        auto& velocity = p.velocities[i];
        bounce(position.x, velocity.x);
        bounce(position.y, velocity.y);
        bounce(position.z, velocity.z);
    }
}

}
