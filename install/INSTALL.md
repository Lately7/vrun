# Cài đặt vrun · Installing vrun

vrun là extension VS Code chạy file `.py` trong một kernel Python giữ biến
giữa các lần chạy, kèm Variable Explorer, DataFrame viewer và trình trực quan
hoá thuật toán (DSA).

## Tiếng Việt

**Cần có:** VS Code 1.90 trở lên và Python 3.12 trở lên. Nếu máy chưa có,
trình cài đặt trên Windows sẽ hỏi rồi cài giúp bằng `winget`.

### Windows

1. Giải nén file `vrun-<phiên bản>-installer.zip` ra một thư mục.
2. Bấm đúp **`install.cmd`**. Trình cài đặt sẽ:
   - tìm VS Code (nếu chưa có thì hỏi để cài bằng winget),
   - tìm Python 3.12+ (nếu chưa có thì hỏi để cài Python 3.13 bằng winget),
   - hỏi có cài `pandas`, `numpy`, `matplotlib`, `openpyxl`, `scikit-learn`,
     `tqdm` vào Python đó không (cho DataFrame, biểu đồ và luyện ML),
   - gỡ tên cũ của extension (PyLive, Veil) nếu có, cài extension **Python**
     của Microsoft (để chọn interpreter) và cài **vrun**.
3. Đóng VS Code rồi mở lại (hoặc chạy lệnh *Developer: Reload Window*).
4. Mở một thư mục và chọn **Trust**, vì vrun chỉ chạy code trong thư mục tin cậy.
5. `Ctrl+Shift+P` → **Python: Select Interpreter** → chọn Python mà trình cài
   đặt đã báo.
6. Mở một file `.py`, bấm **Run Cell** phía trên mỗi dòng `# %%` hoặc
   `Ctrl+Alt+C`. Lệnh *vrun: Show Kernel Log* cho biết kernel đang dùng
   Python nào.
   * Nút tam giác *Run Python File* và Shift+Enter thuộc extension Python
     (chạy trong terminal, vrun không thấy biến). Nếu có extension Jupyter,
     *Run Cell* / Shift+Enter / Ctrl+Enter của Jupyter chạy trong Python
     riêng của Jupyter. Bật `vrun.shiftEnterRunsCell` để các phím này chạy
     trong vrun.
   * File dữ liệu và module của bạn đặt cạnh file `.py` là đọc được, ở thư
     mục nào cũng vậy, không cần chép về thư mục gốc của workspace.

Cài không cần hỏi (dùng cho nhiều máy): `install.cmd -Yes`.

### Luyện ML

* `Ctrl+Shift+P` → **vrun: New Practice File** mở sẵn một bài tập: phân loại
  dữ liệu bảng với scikit-learn, mạng nơ-ron PyTorch hoặc Keras trên chữ số
  viết tay (dữ liệu có sẵn, không cần tải), pandas, thuật toán.
* PyTorch / TensorFlow lớn (vài GB) nên trình cài đặt không tự cài. Cài vào
  đúng Python mà vrun dùng:
  `python -m pip install torch` hoặc `python -m pip install tensorflow`.
* Trong panel Variables: nút **image** xem ảnh của mảng/tensor, nút **chart**
  vẽ đường loss/accuracy, các mô hình hiện số tham số và siêu tham số.

### macOS / Linux

```sh
sh install.sh
```

### Cài thủ công / gỡ cài đặt

```powershell
code --install-extension vrun-0.3.0.vsix
code --uninstall-extension vrun-local.vrun
```

Bạn cũng có thể cài trong VS Code: *Extensions* → `…` → *Install from VSIX…*.

### Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `ModuleNotFoundError: No module named 'pandas'` | Python đang chọn chưa có thư viện: `python -m pip install pandas`, hoặc chọn interpreter khác. |
| Bấm chạy mà không có gì xảy ra | Thư mục chưa được Trust: *Workspaces: Manage Workspace Trust*. |
| Kernel không khởi động | Mở *vrun: Show Kernel Log*. Đặt `vrun.pythonPath` trong Settings để chỉ định file `python.exe`. |
| Vòng lặp chạy mãi | `Ctrl+Alt+I` (Interrupt). Nếu kernel không dừng, chạy *vrun: Restart Kernel*. |
| `UnicodeDecodeError` khi đọc CSV lưu từ Excel | vrun đọc file theo UTF-8. Lưu lại file bằng "CSV UTF-8", hoặc dùng `encoding='cp1258'` (tiếng Việt) / `encoding='cp1252'`. |
| Chữ có dấu bị lỗi khi đọc output của lệnh Windows (`subprocess`) | Thêm `encoding='oem'` hoặc `errors='replace'`. |

## English

**Requires** VS Code 1.90+ and Python 3.12+. On Windows the installer offers
to install missing pieces with `winget`.

* **Windows:** unzip `vrun-<version>-installer.zip` and double-click
  **`install.cmd`**. For an unattended install, run `install.cmd -Yes`; to
  skip the pandas/numpy/matplotlib/openpyxl/scikit-learn/tqdm step, add
  `-NoLibraries`.
* **macOS / Linux:** `sh install.sh`.
* **Manual:** `code --install-extension vrun-0.3.0.vsix`.

Then reload VS Code, open a folder and trust it, pick your interpreter with
*Python: Select Interpreter*, open a `.py` file and click **Run Cell** above a
`# %%` line or press `Ctrl+Alt+C`. The triangle *Run Python File* and
Shift+Enter belong to the Python extension and run in a terminal, where vrun
sees no variables; with the Jupyter extension, Shift+Enter / Ctrl+Enter run in
Jupyter's own Python. Turn on `vrun.shiftEnterRunsCell` to make them run in
vrun. Files next to your script are found from any folder. Text files are read
as UTF-8: save Excel CSVs as "CSV UTF-8" (or pass `encoding='cp1252'`), and
pass `encoding='oem'` to `subprocess.run(..., text=True)` for Windows console
tools that print accented text.
For ML practice run *vrun: New Practice File*; install PyTorch or TensorFlow
yourself (`python -m pip install torch`), they are too large to offer.
