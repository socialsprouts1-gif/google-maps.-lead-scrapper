document.addEventListener('DOMContentLoaded', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        var currentTab = tabs[0];
        var actionButton = document.getElementById('actionButton');
        var downloadCsvButton = document.getElementById('downloadCsvButton');
        var resultsTable = document.getElementById('resultsTable');
        var filenameInput = document.getElementById('filenameInput');

        if (currentTab && currentTab.url.includes("://www.google.com/maps/search")) {
            document.getElementById('message').textContent = "Let's scrape Google Maps!";
            actionButton.disabled = false;
            actionButton.classList.add('enabled');
        } else {
            var messageElement = document.getElementById('message');
            messageElement.innerHTML = '';
            var linkElement = document.createElement('a');
            linkElement.href = 'https://www.google.com/maps/search/';
            linkElement.textContent = "Go to Google Maps Search.";
            linkElement.target = '_blank'; 
            messageElement.appendChild(linkElement);

            actionButton.style.display = 'none'; 
            downloadCsvButton.style.display = 'none';
            filenameInput.style.display = 'none'; 
        }

        actionButton.addEventListener('click', function() {
            chrome.scripting.executeScript({
                target: {tabId: currentTab.id},
                function: scrapeData
            }, function(results) {
                while (resultsTable.firstChild) {
                    resultsTable.removeChild(resultsTable.firstChild);
                }

                // Define and add headers to the table
                const headers = ['Title', 'Rating', 'Reviews', 'Phone', 'Industry', 'Address', 'Website', 'Google Maps Link'];
                const headerRow = document.createElement('tr');
                headers.forEach(headerText => {
                    const header = document.createElement('th');
                    header.textContent = headerText;
                    headerRow.appendChild(header);
                });
                resultsTable.appendChild(headerRow);

                // Add new results to the table
                if (!results || !results[0] || !results[0].result) return;
                results[0].result.forEach(function(item) {
                    var row = document.createElement('tr');
                    ['title', 'rating', 'reviewCount', 'phone', 'industry', 'address', 'companyUrl', 'href'].forEach(function(key) {
                        var cell = document.createElement('td');
                        
                        if (key === 'reviewCount' && item[key]) {
                            item[key] = item[key].replace(/\(|\)/g, ''); 
                        }
                        
                        cell.textContent = item[key] || ''; 
                        row.appendChild(cell);
                    });
                    resultsTable.appendChild(row);
                });

                if (results && results[0] && results[0].result && results[0].result.length > 0) {
                    downloadCsvButton.disabled = false;
                }
            });
        });

        downloadCsvButton.addEventListener('click', function() {
            var csv = tableToCsv(resultsTable); 
            var filename = filenameInput.value.trim();
            if (!filename) {
                filename = 'google-maps-data.csv'; 
            } else {
                filename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.csv';
            }
            downloadCsv(csv, filename); 
        });

    });
});


function scrapeData() {
    var links = Array.from(document.querySelectorAll('a[href^="https://www.google.com/maps/place"]'));
    return links.map(link => {
        var container = link.closest('[jsaction*="mouseover:pane"]');
        var titleText = container ? container.querySelector('.fontHeadlineSmall').textContent : '';
        var rating = '';
        var reviewCount = '';
        var phone = '';
        var industry = '';
        var address = '';
        var companyUrl = '';

        // Rating and Reviews
        if (container) {
            var roleImgContainer = container.querySelector('[role="img"]');
            
            if (roleImgContainer) {
                var ariaLabel = roleImgContainer.getAttribute('aria-label');
            
                if (ariaLabel && ariaLabel.includes("stars")) {
                    var parts = ariaLabel.split(' ');
                    var rating = parts[0];
                    var reviewCount = '(' + parts[2] + ')'; 
                } else {
                    rating = '0';
                    reviewCount = '0';
                }
            }
        }

        // Info lines of the result card, each split on the "·" separator, e.g.
        //   ["Chartered accountant", "A-309 Privilon, Ambli Rd"]
        //   ["Closed", "Opens 10 am", "090168 75077"]
        var infoLines = [];
        if (container) {
            Array.from(container.querySelectorAll('.W4Efsd')).forEach(function(line) {
                if (line.querySelector('.W4Efsd') || line.querySelector('[role="img"]')) return;
                var segments = (line.textContent || '').split(/[·⋅]/).map(function(s) {
                    return s.replace(/\s+/g, ' ').trim();
                }).filter(function(s) { return s; });
                if (segments.length) infoLines.push(segments);
            });
        }

        // Phone Numbers (any country format and length, leading zeros kept)
        if (container) {
            var phoneEl = container.querySelector('.UsdlK');
            if (phoneEl && isPhoneNumber(phoneEl.textContent.trim())) {
                phone = phoneEl.textContent.trim();
            }
            if (!phone) {
                infoLines.some(function(segments) {
                    phone = segments.find(isPhoneNumber) || '';
                    return phone;
                });
            }
            if (!phone) {
                var phoneMatches = (container.textContent || '').match(/\+?\(?\d[\d\s().-]{5,}\d/g) || [];
                phone = phoneMatches.map(function(m) { return m.trim(); }).find(isPhoneNumber) || '';
            }
        }

        // Industry and Address
        if (container) {
            var detailLine = infoLines.find(function(segments) {
                return !segments.some(function(segment) {
                    return isPhoneNumber(segment) || /^(Open|Closed|Opens|Closes|Temporarily closed|Permanently closed)\b/i.test(segment);
                });
            });
            if (detailLine) {
                industry = detailLine[0];
                if (detailLine.length > 1) {
                    address = detailLine[detailLine.length - 1];
                }
            } else {
                // Fallback: text-based parsing, with the phone number removed
                // so it can't be mistaken for an address
                var containerText = container.textContent || '';
                if (phone) {
                    containerText = containerText.split(phone).join(' ');
                }
                var addressRegex = /\d+ [\w\s]+(?:#\s*\d+|Suite\s*\d+|Apt\s*\d+)?/;
                var addressMatch = containerText.match(addressRegex);

                if (addressMatch) {
                    address = addressMatch[0];

                    // Extract industry text based on the position before the address
                    var textBeforeAddress = containerText.substring(0, containerText.indexOf(address)).trim();
                    var ratingIndex = textBeforeAddress.lastIndexOf(rating + reviewCount);
                    if (ratingIndex !== -1) {
                        // Assuming industry is the first significant text after rating and review count
                        var rawIndustryText = textBeforeAddress.substring(ratingIndex + (rating + reviewCount).length).trim().split(/[\r\n]+/)[0];
                        industry = rawIndustryText.replace(/[·.,#!?]/g, '').trim();
                    }
                    var filterRegex = /\b(Closed|Open 24 hours|24 hours)|Open\b/g;
                    address = address.replace(filterRegex, '').trim();
                    address = address.replace(/(\d+)(Open)/g, '$1').trim();
                    address = address.replace(/(\w)(Open)/g, '$1').trim();
                    address = address.replace(/(\w)(Closed)/g, '$1').trim();
                }
            }
        }

        // Company URL
        if (container) {
            var allLinks = Array.from(container.querySelectorAll('a[href]'));
            var filteredLinks = allLinks.filter(a => !a.href.startsWith("https://www.google.com/maps/place/"));
            if (filteredLinks.length > 0) {
                companyUrl = filteredLinks[0].href;
            }
        }

        // Return the data as an object
        return {
            title: titleText,
            rating: rating,
            reviewCount: reviewCount,
            phone: phone,
            industry: industry,
            address: address,
            companyUrl: companyUrl,
            href: link.href,
        };
    });

    // A phone number: optional "+", then digits with spaces, dashes, dots or
    // parentheses. 7-15 digits (the international maximum), so leading zeros
    // and long numbers like "090168 75077" or "+91 98765 43210" stay whole.
    function isPhoneNumber(text) {
        if (!/^\+?[\d\s().-]+$/.test(text)) return false;
        if (/^\d+\.\d+\s*\(/.test(text)) return false; // rating like "4.9(312)"
        var digits = text.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 15;
    }
}

// Convert the table to a CSV string
function tableToCsv(table) {
    var csv = [];
    var rows = table.querySelectorAll('tr');
    
    for (var i = 0; i < rows.length; i++) {
        var row = [], cols = rows[i].querySelectorAll('td, th');
        
        for (var j = 0; j < cols.length; j++) {
            var value = (cols[j].textContent || '').trim();
            // Write phone numbers as text so Excel/Sheets keep the leading zero
            if (cols[j].tagName === 'TD' && j === 3 && value) {
                value = '="' + value + '"';
            }
            row.push('"' + value.replace(/"/g, '""') + '"');
        }
        csv.push(row.join(','));
    }
    return csv.join('\r\n');
}

// Download the CSV file
function downloadCsv(csv, filename) {
    var csvFile;
    var downloadLink;

    // UTF-8 BOM so Excel shows characters like "–" correctly
    csvFile = new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8'});
    downloadLink = document.createElement('a');
    downloadLink.download = filename;
    downloadLink.href = window.URL.createObjectURL(csvFile);
    downloadLink.style.display = 'none';
    document.body.appendChild(downloadLink);
    downloadLink.click();
}
