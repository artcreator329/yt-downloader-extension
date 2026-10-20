"""Unit tests for pick_formats. Run: python3 -m unittest server/test_pick_formats.py

Format lists mirror real yt-dlp --dump-json output for YouTube (itags, codecs,
ordering worst -> best), trimmed to the fields pick_formats reads.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remote_vps_server as srv  # noqa: E402


def fmt(itag, height, vcodec, acodec, dynamic_range="SDR", scheme="https"):
    return {
        "format_id": str(itag),
        "url": f"{scheme}://rr1---sn-test.googlevideo.com/videoplayback?itag={itag}",
        "height": height,
        "vcodec": vcodec,
        "acodec": acodec,
        "dynamic_range": dynamic_range if vcodec != "none" else None,
    }


def itag_of(url):
    return url.rsplit("itag=", 1)[1] if url else None


AUDIO = [
    fmt(249, None, "none", "opus"),
    fmt(250, None, "none", "opus"),
    fmt(139, None, "none", "mp4a.40.5"),
    fmt(140, None, "none", "mp4a.40.2"),
    fmt(251, None, "none", "opus"),
]

# A 4K60 upload, in the order yt-dlp sorts YouTube formats.
FORMATS_4K = AUDIO[:2] + [
    fmt(18, 360, "avc1.42001E", "mp4a.40.2"),  # progressive
] + AUDIO[2:] + [
    fmt(160, 144, "avc1.4d400c", "none"),
    fmt(278, 144, "vp9", "none"),
    fmt(394, 144, "av01.0.00M.08", "none"),
    fmt(133, 240, "avc1.4d4015", "none"),
    fmt(242, 240, "vp9", "none"),
    fmt(395, 240, "av01.0.00M.08", "none"),
    fmt(134, 360, "avc1.4d401e", "none"),
    fmt(243, 360, "vp9", "none"),
    fmt(396, 360, "av01.0.01M.08", "none"),
    fmt(135, 480, "avc1.4d401f", "none"),
    fmt(244, 480, "vp9", "none"),
    fmt(397, 480, "av01.0.04M.08", "none"),
    fmt(136, 720, "avc1.4d401f", "none"),
    fmt(298, 720, "avc1.4d4020", "none"),
    fmt(247, 720, "vp9", "none"),
    fmt(302, 720, "vp9", "none"),
    fmt(398, 720, "av01.0.08M.08", "none"),
    fmt(137, 1080, "avc1.640028", "none"),
    fmt(299, 1080, "avc1.64002a", "none"),
    fmt(248, 1080, "vp9", "none"),
    fmt(303, 1080, "vp9", "none"),
    fmt(399, 1080, "av01.0.09M.08", "none"),
    fmt(308, 1440, "vp9", "none"),
    fmt(400, 1440, "av01.0.12M.08", "none"),
    fmt(315, 2160, "vp9", "none"),
    fmt(337, 2160, "vp09.02.51.10.01.09.16.09.00", "none", dynamic_range="HDR10"),
    fmt(401, 2160, "av01.0.13M.08", "none"),
    # Non-https entries must never be chosen, even if they look best.
    fmt(9999, 2160, "avc1.640033", "none", scheme="http"),
]

# A 1080p-max upload.
FORMATS_1080 = [f for f in FORMATS_4K if (f["height"] or 0) <= 1080]


class PickFormatsTest(unittest.TestCase):
    def pick(self, formats, quality):
        return srv.pick_formats({"formats": formats}, quality)

    def test_4k_picks_2160p_vp9_over_av1_and_hdr(self):
        spec = self.pick(FORMATS_4K, "4k")
        self.assertEqual(spec["type"], "remux")
        self.assertEqual(itag_of(spec["video_url"]), "315")  # 2160p VP9 SDR
        self.assertEqual(itag_of(spec["audio_url"]), "140")  # AAC

    def test_1440p_picks_1440p_vp9(self):
        self.assertEqual(itag_of(self.pick(FORMATS_4K, "1440p")["video_url"]), "308")

    def test_4k_falls_back_to_av1_when_no_vp9(self):
        no_vp9 = [f for f in FORMATS_4K if not f["vcodec"].startswith(("vp9", "vp09"))]
        self.assertEqual(itag_of(self.pick(no_vp9, "4k")["video_url"]), "401")

    def test_4k_takes_hdr_only_when_it_is_the_only_2160p(self):
        hdr_only = [f for f in FORMATS_4K if f["format_id"] not in ("315", "401")]
        self.assertEqual(itag_of(self.pick(hdr_only, "4k")["video_url"]), "337")

    def test_1080p_still_prefers_avc(self):
        for formats in (FORMATS_4K, FORMATS_1080):
            spec = self.pick(formats, "1080p")
            self.assertEqual(itag_of(spec["video_url"]), "299")  # last AVC at 1080, as before
            self.assertEqual(itag_of(spec["audio_url"]), "140")

    def test_4k_on_1080p_video_gives_1080p_avc(self):
        self.assertEqual(itag_of(self.pick(FORMATS_1080, "4k")["video_url"]), "299")

    def test_720p_and_360p_unchanged(self):
        self.assertEqual(itag_of(self.pick(FORMATS_4K, "720p")["video_url"]), "298")
        spec = self.pick(FORMATS_4K, "360p")
        self.assertEqual(spec["type"], "progressive")
        self.assertEqual(itag_of(spec["url"]), "18")

    def test_mp3(self):
        spec = self.pick(FORMATS_4K, "mp3")
        self.assertEqual(spec["type"], "audio")
        self.assertEqual(itag_of(spec["audio_url"]), "251")

    def test_never_picks_non_https(self):
        spec = self.pick(FORMATS_4K, "4k")
        for url in (spec["video_url"], spec["audio_url"]):
            self.assertTrue(url.startswith("https://"))


if __name__ == "__main__":
    unittest.main()
