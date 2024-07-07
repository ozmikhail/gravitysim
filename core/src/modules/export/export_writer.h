#pragma once

#include <cstddef>
#include <filesystem>
#include <fstream>
#include <vector>

namespace grav {

struct Particles;

struct FrameSample {
    std::size_t frame = 0;
    std::size_t run = 0;
    std::size_t step = 0;
    double time = 0.0;
};

class ExportWriter {
public:
    ExportWriter(const std::filesystem::path& positions, const std::filesystem::path& frames);

    [[nodiscard]] bool writes_positions() const { return positions_.is_open(); }
    [[nodiscard]] bool writes_frames() const { return !frames_.empty(); }

    void write_positions(const FrameSample& sample, const Particles& particles);
    void write_frame(
        const FrameSample& sample, int width, int height, const std::vector<unsigned char>& rgb
    );

private:
    std::filesystem::path positions_path_;
    std::filesystem::path frames_;
    std::ofstream positions_;
};

}
