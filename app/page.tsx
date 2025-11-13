'use client'

import { useState, useEffect } from 'react'

export default function Home() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [specificAnswer, setSpecificAnswer] = useState<any>(null)
  const [comparisonData, setComparisonData] = useState<any>(null)
  
  // Filter states
  const [selectedFamily, setSelectedFamily] = useState('')
  const [selectedProductType, setSelectedProductType] = useState('')
  const [selectedProductModel, setSelectedProductModel] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  
  // Available filter options
  const [filterOptions, setFilterOptions] = useState<{
    families: string[]
    productTypes: string[]
    productModels: string[]
  }>({
    families: [],
    productTypes: [],
    productModels: []
  })
  const [loadingFilters, setLoadingFilters] = useState(true)

  // Load filter options on mount
  useEffect(() => {
    loadFilterOptions()
  }, [])

const loadFilterOptions = async () => {
  setLoadingFilters(true)
  try {
    // Build query params for current filters
    const params = new URLSearchParams()
    if (selectedFamily) params.append('family', selectedFamily)
    if (selectedProductType) params.append('productType', selectedProductType)
    if (selectedProductModel) params.append('productModel', selectedProductModel)

    // Call the filter-options API with GET
    const url = `/api/filter-options${params.toString() ? `?${params.toString()}` : ''}`
    console.log('🔍 Fetching from URL:', url) // Debug log
    const response = await fetch(url)
    
    if (response.ok) {
      const data = await response.json()
      console.log('📦 Full API response:', data) // Debug log
      console.log('📊 Families array:', data.families) // Debug log
      console.log('📊 Types array:', data.productTypes) // Debug log
      console.log('📊 Models array:', data.productModels) // Debug log
      
      if (data.success) {
        setFilterOptions({
          families: data.families || [],
          productTypes: data.productTypes || [],
          productModels: data.productModels || []
        })
        console.log('✅ Loaded filter options:', {
          families: data.families?.length || 0,
          types: data.productTypes?.length || 0,
          models: data.productModels?.length || 0
        })
      }
    } else {
      console.error('Failed to load filter options:', response.status)
    }
  } catch (err) {
    console.error('Failed to load filter options:', err)
  } finally {
    setLoadingFilters(false)
  }
}

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setResults([])
    setSpecificAnswer(null)
    setComparisonData(null)

    try {
      const response = await fetch('/api/smart-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query,
          filters: {
            family: selectedFamily,
            productType: selectedProductType,
            productModel: selectedProductModel
          }
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Search failed')
      }

      // Handle comparison responses
      if (data.questionType === 'comparison') {
        setComparisonData(data)
        setResults(data.products || [])
      }
      // Handle specific question responses
      else if (data.questionType === 'specific') {
        setSpecificAnswer(data)
        if (data.fullProduct) {
          setResults([data.fullProduct])
        }
      } 
      // Handle list responses
      else {
        setResults(data.results || [])
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const clearFilters = () => {
    setSelectedFamily('')
    setSelectedProductType('')
    setSelectedProductModel('')
  }

  const hasActiveFilters = selectedFamily || selectedProductType || selectedProductModel

  // Group attributes by category for better display
  const groupAttributes = (product: any) => {
    const priorityFields = ['sku', 'name', 'product_name', 'productname', 'description', 'product_description']
    const footerFields = ['created_at', 'updated_at', 'createdat', 'updatedat']
    const searchableFields = ['searchable_text', 'searchabletext', 'searchable']
    
    const priority: any = {}
    const footer: any = {}
    const searchable: any = {}
    const other: any = {}
    const seen = new Set<string>()

    Object.entries(product).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase()
      
      if (seen.has(lowerKey)) return
      seen.add(lowerKey)
      
      if (priorityFields.includes(lowerKey)) {
        priority[key] = value
      } else if (footerFields.includes(lowerKey)) {
        footer[key] = value
      } else if (searchableFields.includes(lowerKey)) {
        searchable[key] = value
      } else {
        other[key] = value
      }
    })

    return { priority, other, searchable, footer }
  }

  // Format field name for display
  const formatFieldName = (key: string): string => {
    const fieldMappings: { [key: string]: string } = {
      'sku': 'SKU',
      'product_name': 'Product Name',
      'productname': 'Product Name',
      'product_description': 'Description',
    }
    
    const lowerKey = key.toLowerCase()
    if (fieldMappings[lowerKey]) {
      return fieldMappings[lowerKey]
    }
    
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }

  // Format date values
  const formatValue = (key: string, value: any): string => {
    const lowerKey = key.toLowerCase()
    if ((lowerKey.includes('created') || lowerKey.includes('updated')) && 
        typeof value === 'string' && value.includes('T')) {
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }
    return String(value)
  }

  // Get all unique keys from products for comparison
  const getAllKeys = (products: any[]) => {
    const allKeys = new Set<string>()
    const seenLowerKeys = new Set<string>()
    
    products.forEach(product => {
      Object.keys(product).forEach(key => {
        const lowerKey = key.toLowerCase()
        if (!seenLowerKeys.has(lowerKey)) {
          allKeys.add(key)
          seenLowerKeys.add(lowerKey)
        }
      })
    })
    return Array.from(allKeys)
  }

  // Check if values are different across products
  const isDifferent = (key: string, products: any[]) => {
    const values = products.map(p => p[key])
    return new Set(values).size > 1
  }

  // Render comparison table
  const renderComparison = () => {
    if (!comparisonData || !comparisonData.products || comparisonData.products.length < 2) {
      return null
    }

    const products = comparisonData.products
    const allKeys = getAllKeys(products)
    
    const priorityFields = ['sku', 'product_name', 'productname', 'name']
    const excludeFields = ['created_at', 'updated_at', 'createdat', 'updatedat', 'searchable_text', 'searchabletext']
    
    const priority = allKeys.filter(k => priorityFields.includes(k.toLowerCase()))
    const technical = allKeys.filter(k => 
      !priorityFields.includes(k.toLowerCase()) && 
      !excludeFields.includes(k.toLowerCase())
    )

    return (
      <div className="mb-8">
        <div className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-l-4 border-blue-500 p-6 rounded-lg">
          <h2 className="text-2xl font-bold text-blue-900 mb-2">Coating Comparison</h2>
          <p className="text-blue-700">Comparing {products.length} coatings - Differences are highlighted</p>
        </div>

        <div className="bg-white rounded-lg shadow-lg overflow-hidden border border-gray-200">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b-2 border-gray-200">
                  <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700 w-1/4 sticky left-0 bg-gray-50 z-10">
                    Attribute
                  </th>
                  {products.map((product: any, idx: number) => (
                    <th 
                      key={idx} 
                      className="px-6 py-4 text-left text-sm font-semibold"
                      style={{ color: '#0078a9' }}
                    >
                      Coating {idx + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {priority.map((key) => {
                  const different = isDifferent(key, products)
                  return (
                    <tr 
                      key={key} 
                      className={`border-b border-gray-200 ${different ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-6 py-4 text-sm font-semibold text-gray-700 sticky left-0 bg-white z-10">
                        <div className="flex items-center gap-2">
                          {formatFieldName(key)}
                          {different && (
                            <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full" title="Different values"></span>
                          )}
                        </div>
                      </td>
                      {products.map((product: any, idx: number) => (
                        <td 
                          key={idx} 
                          className={`px-6 py-4 text-sm text-gray-900 ${different ? 'font-semibold' : ''}`}
                        >
                          {formatValue(key, product[key]) || '-'}
                        </td>
                      ))}
                    </tr>
                  )
                })}

                <tr className="bg-gray-100">
                  <td colSpan={products.length + 1} className="px-6 py-3 text-xs font-bold uppercase tracking-wide" style={{ color: '#0078a9' }}>
                    Technical Specifications
                  </td>
                </tr>

                {technical.map((key) => {
                  const different = isDifferent(key, products)
                  return (
                    <tr 
                      key={key} 
                      className={`border-b border-gray-200 ${different ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-6 py-3 text-sm text-gray-700 sticky left-0 bg-white z-10">
                        <div className="flex items-center gap-2">
                          {formatFieldName(key)}
                          {different && (
                            <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full" title="Different values"></span>
                          )}
                        </div>
                      </td>
                      {products.map((product: any, idx: number) => (
                        <td 
                          key={idx} 
                          className={`px-6 py-3 text-sm text-gray-900 ${different ? 'font-semibold' : ''}`}
                        >
                          {formatValue(key, product[key]) || '-'}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
          <span className="inline-block w-3 h-3 bg-yellow-50 border border-yellow-200 rounded"></span>
          <span>Highlighted rows indicate differences between coatings</span>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen p-8 max-w-7xl mx-auto bg-gray-50">
      <div className="bg-white rounded-lg shadow-sm p-8 mb-8">
        <h1 className="text-4xl font-bold mb-2 text-center" style={{ color: '#0078a9' }}>
          Coatings Smart Search
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Search coatings using natural language
        </p>

        <form onSubmit={handleSearch}>
          <div className="flex gap-4 mb-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask anything about coatings... (e.g., 'Compare coating A and coating B')"
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent"
            />
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              className="px-6 py-3 border-2 rounded-lg font-medium transition-colors"
              style={{ 
                borderColor: '#0078a9',
                color: showFilters ? '#fff' : '#0078a9',
                backgroundColor: showFilters ? '#0078a9' : 'transparent'
              }}
            >
              <svg className="w-5 h-5 inline-block mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              Filters
              {hasActiveFilters && (
                <span className="ml-2 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
                  {[selectedFamily, selectedProductType, selectedProductModel].filter(Boolean).length}
                </span>
              )}
            </button>
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-8 py-3 text-white rounded-lg hover:opacity-90 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-colors"
              style={{ backgroundColor: '#0078a9' }}
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>

          {/* Filter Panel */}
          {showFilters && (
            <div className="border border-gray-200 rounded-lg p-6 bg-gray-50">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold" style={{ color: '#0078a9' }}>
                  Filter Options {loadingFilters && <span className="text-sm font-normal text-gray-500">(Updating...)</span>}
                </h3>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-sm text-red-600 hover:text-red-800 font-medium"
                  >
                    Clear All Filters
                  </button>
                )}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Family Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Family ({filterOptions.families.length} options)
                  </label>
                  <select
                    value={selectedFamily}
                    onChange={(e) => setSelectedFamily(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100"
                  >
                    <option value="">All Families</option>
                    {filterOptions.families.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Product Type Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Product Type ({filterOptions.productTypes.length} options)
                  </label>
                  <select
                    value={selectedProductType}
                    onChange={(e) => setSelectedProductType(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100"
                  >
                    <option value="">All Types</option>
                    {filterOptions.productTypes.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Product Model Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Product Model ({filterOptions.productModels.length} options)
                  </label>
                  <select
                    value={selectedProductModel}
                    onChange={(e) => setSelectedProductModel(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100"
                  >
                    <option value="">All Models</option>
                    {filterOptions.productModels.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {hasActiveFilters && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="text-sm text-gray-600">Active filters:</span>
                  {selectedFamily && (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                      Family: {selectedFamily}
                      <button
                        type="button"
                        onClick={() => setSelectedFamily('')}
                        className="ml-2 text-blue-600 hover:text-blue-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {selectedProductType && (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                      Type: {selectedProductType}
                      <button
                        type="button"
                        onClick={() => setSelectedProductType('')}
                        className="ml-2 text-green-600 hover:text-green-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {selectedProductModel && (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 text-purple-800">
                      Model: {selectedProductModel}
                      <button
                        type="button"
                        onClick={() => setSelectedProductModel('')}
                        className="ml-2 text-purple-600 hover:text-purple-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </form>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Comparison View */}
      {comparisonData && renderComparison()}

      {/* Specific Answer Display */}
      {specificAnswer && (
        <div className="mb-6 bg-blue-50 border-l-4 border-blue-500 p-6 rounded-lg">
          <div className="flex items-start">
            <div className="flex-shrink-0">
              <svg className="h-6 w-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-3 flex-1">
              <h3 className="text-lg font-semibold text-blue-900 mb-2">Answer</h3>
              <p className="text-blue-800 text-lg">{specificAnswer.answer}</p>
              
              {specificAnswer.extractedData && Object.keys(specificAnswer.extractedData).length > 0 && (
                <div className="mt-4 bg-white rounded-lg p-4 border border-blue-200">
                  <h4 className="font-semibold text-sm text-blue-900 mb-2">Extracted Information:</h4>
                  <div className="space-y-1">
                    {Object.entries(specificAnswer.extractedData).map(([key, value]) => (
                      <div key={key} className="text-sm">
                        <span className="font-medium text-gray-700">{formatFieldName(key)}:</span>{' '}
                        <span className="text-gray-900">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Regular List View */}
      {results.length > 0 && !comparisonData && (
        <div>
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-2xl font-semibold" style={{ color: '#0078a9' }}>
              {specificAnswer ? 'Full Coating Details' : `Found ${results.length} ${results.length === 1 ? 'result' : 'results'}`}
            </h2>
          </div>

          <div className="space-y-6">
            {results.map((product, index) => {
              const { priority, other, searchable, footer } = groupAttributes(product)
              
              return (
                <div
                  key={index}
                  className="bg-white border border-gray-200 rounded-lg p-6 hover:shadow-lg transition-shadow"
                >
                  {Object.keys(priority).length > 0 && (
                    <div className="mb-4 pb-4 border-b border-gray-200">
                      <div className="space-y-3">
                        {Object.entries(priority).map(([key, value]) => (
                          <div key={key}>
                            <span 
                              className="font-semibold text-sm uppercase tracking-wide"
                              style={{ color: '#0078a9' }}
                            >
                              {formatFieldName(key)}:
                            </span>{' '}
                            <span className="text-gray-900">
                              {formatValue(key, value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {Object.keys(other).length > 0 && (
                    <div className="mb-4">
                      <h3 
                        className="font-semibold mb-3 text-sm uppercase tracking-wide"
                        style={{ color: '#0078a9' }}
                      >
                        Technical Specifications
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                        {Object.entries(other).map(([key, value]) => (
                          <div key={key} className="flex flex-col">
                            <span className="text-gray-600 text-xs">
                              {formatFieldName(key)}
                            </span>
                            <span className="text-gray-900 font-medium">
                              {formatValue(key, value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {Object.keys(searchable).length > 0 && (
                    <div className="mb-4 pb-4 border-b border-gray-200">
                      {Object.entries(searchable).map(([key, value]) => (
                        <div key={key}>
                          <span 
                            className="font-semibold text-sm uppercase tracking-wide"
                            style={{ color: '#0078a9' }}
                          >
                            {formatFieldName(key)}:
                          </span>
                          <div className="mt-2 text-gray-700 text-sm bg-gray-50 p-3 rounded">
                            {formatValue(key, value)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {Object.keys(footer).length > 0 && (
                    <div className="pt-4 border-t border-gray-200">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-gray-500">
                        {Object.entries(footer).map(([key, value]) => (
                          <div key={key}>
                            <span className="font-medium">
                              {formatFieldName(key)}:
                            </span>{' '}
                            {formatValue(key, value)}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!loading && results.length === 0 && query && !error && !specificAnswer && !comparisonData && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 text-lg">You are searching for "{query}"</p>
          <p className="text-gray-400 text-sm mt-2">Please press the search button to send the query to the system</p>
        </div>
      )}
    </main>
  )
}
