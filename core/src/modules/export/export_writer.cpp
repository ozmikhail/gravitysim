#include "modules/export/export_writer.h"

#include <cmath>
#include <iomanip>
#include <limits>
#include <locale>
#include <ostream>
#include <sstream>

#include "error.h"
#include "modules/sim/particles.h"

namespace grav {

namespace {

void write_number(std::ostream& out, double value) {
    if (std::isfinite(value)) {
        out << value;
    } else {
        out << "null";
    }
}

AppError write_error(const std::filesystem::path& path) {
    return AppError::dependency_unavailable("export: could not write " + path.string());
}

}

ExportWriter::ExportWriter(
    const std::filesystem::path& positions, const std::filesystem::path& frames
) : positions_path_(positions), frames_(frames) {
    if (!positions.empty() && std::filesystem::exists(positions)) {
        throw AppError::conflict("export: position stream already exists: " + positions.string());
    }
    if (writes_frames() && !std::filesystem::create_directories(frames_)) {
        throw AppError::conflict("export: frame directory already exists: " + frames_.string());
    }
    if (!positions.empty()) {
        if (positions.has_parent_path()) {
            std::filesystem::create_directories(positions.parent_path());
        }
        positions_.open(positions, std::ios::binary);
        if (!positions_) {
            throw write_error(positions);
        }
        positions_.imbue(std::locale::classic());
        positions_ << std::setprecision(std::numeric_limits<double>::max_digits10);
    }
}

void ExportWriter::write_positions(const FrameSample& sample, const Particles& particles) {
    positions_ << "{\"frame\":" << sample.frame << ",\"run\":" << sample.run
               << ",\"step\":" << sample.step << ",\"time\":";
    write_number(positions_, sample.time);
    positions_ << ",\"positions\":[";
    for (std::size_t i = 0; i < particles.count(); ++i) {
        if (i != 0) {
            positions_ << ',';
        }
        const auto p = particles.positions[i];
        positions_ << '[' << particles.id(i) << ',';
        write_number(positions_, p.x);
        positions_ << ',';
        write_number(positions_, p.y);
        positions_ << ',';
        write_number(positions_, p.z);
        positions_ << ']';
    }
    positions_ << "]}\n" << std::flush;
    if (!positions_) {
        throw write_error(positions_path_);
    }
}

void ExportWriter::write_frame(
    const FrameSample& sample, int width, int height, const std::vector<unsigned char>& rgb
) {
    std::ostringstream name;
    name.imbue(std::locale::classic());
    name << "frame-" << std::setfill('0') << std::setw(6) << sample.frame << ".ppm";
    const auto path = frames_ / name.str();
    std::ofstream out(path, std::ios::binary);
    out.imbue(std::locale::classic());
    out << "P6\n" << width << ' ' << height << "\n255\n";
    const auto row_bytes = static_cast<std::size_t>(width) * 3;
    for (int row = height - 1; row >= 0; --row) {
        out.write(reinterpret_cast<const char*>(rgb.data() + row * row_bytes), row_bytes);
    }
    out.close();
    if (!out) {
        throw write_error(path);
    }
}

}
